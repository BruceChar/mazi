#!/usr/bin/env python3
"""LEGACY compatibility CLI for Project Wiki.

Mazi runtime no longer calls this file. The authoritative implementation is
packages/runtime/src/wiki/project-wiki.ts and ProjectWikiService. This command
is retained only for external projects that still invoke wiki.py directly.

Single-file, stdlib-only (Python >= 3.9; uses tomllib with a claims fallback).
All write operations auto-commit the wiki/ path only (pathspec-limited);
user's staged WIP is never swept in.

oid semantics (four modes, see design doc §7.2):
  claim write   -> worktree oid   (git hash-object)
  gate --staged -> index oid     (git ls-files -s)
  drift detect  -> worktree oid
  fast triage   -> git status names only
"""

import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.9/3.10 fallback for claims.toml
    tomllib = None

__version__ = "1.3.0"

HOOK_MARK = "# project-wiki gate"
AGENTS_MARK_START = "<!-- WIKI:START -->"
AGENTS_MARK_END = "<!-- WIKI:END -->"
CLAIMS_HEADER = (
    "# wiki/claims.toml — 只通过 wiki.py claim 修改，禁止手改\n"
    "# status 落盘仅 active|retracted；stale/missing 由 doctor 运行时推导\n"
)
LINE_WARN = 150
ACTIVITY_START = "<!-- activity:start -->"
ACTIVITY_END = "<!-- activity:end -->"
ACTIVITY_COMMIT_SUBJECT = "wiki(run): record session activity"


# ---------------------------------------------------------------- errors ---

def die(msg: str, code: int = 2):
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(code)


# ------------------------------------------------------------- toml mini ---

def toml_str(s: str) -> str:
    out = (s.replace("\\", "\\\\").replace('"', '\\"')
            .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t"))
    return f'"{out}"'


def dump_claims(claims: dict) -> str:
    lines = [CLAIMS_HEADER, ""]
    for cid, c in claims.items():
        lines.append(f"[claims.{cid}]")
        lines.append(f"text = {toml_str(c.get('text', ''))}")
        lines.append(f"status = {toml_str(c.get('status', 'active'))}")
        evs = c.get("evidence", [])
        if not evs:
            lines.append("evidence = []")
        else:
            lines.append("evidence = [")
            for e in evs:
                parts = [f"file = {toml_str(e['file'])}"]
                if e.get("hint"):
                    parts.append(f"hint = {toml_str(e['hint'])}")
                parts.append(f"oid = {toml_str(e.get('oid', ''))}")
                lines.append("  { " + ", ".join(parts) + " },")
            lines.append("]")
        lines.append(f"established = {c.get('established', '1970-01-01')}")
        lines.append(f"verified = {c.get('verified', '1970-01-01')}")
        if c.get("status") == "retracted":
            lines.append(f"retracted_at = {c.get('retracted_at', '1970-01-01')}")
            lines.append(f"retracted_reason = {toml_str(c.get('retracted_reason', ''))}")
        if c.get("claim_oid"):
            lines.append(f"claim_oid = {toml_str(c['claim_oid'])}")
        lines.append("")
    return "\n".join(lines)


def parse_claim_string(body: str, key: str):
    match = re.search(
        rf"(?:^|[,\n{{])\s*{re.escape(key)}\s*=\s*\"((?:\\.|[^\"\\])*)\"",
        body,
        re.M,
    )
    if not match:
        return None
    try:
        return json.loads(f'"{match.group(1)}"')
    except json.JSONDecodeError:
        return match.group(1)


def parse_claims_toml(text: str) -> dict:
    """Parse claims.toml on Python < 3.11 without a third-party TOML library."""
    matches = list(re.finditer(r"^\[claims\.([^\]]+)\]\s*$", text, re.M))
    claims = {}
    for index, match in enumerate(matches):
        body = text[match.end():matches[index + 1].start() if index + 1 < len(matches) else len(text)]
        claim = {
            "text": parse_claim_string(body, "text") or "",
            "status": parse_claim_string(body, "status") or "active",
        }
        evidence_block = re.search(r"^evidence\s*=\s*\[(.*?)^\]", body, re.M | re.S)
        evidence = []
        if evidence_block:
            for entry in re.findall(r"\{([\s\S]*?)\}", evidence_block.group(1)):
                file = parse_claim_string(entry, "file")
                oid = parse_claim_string(entry, "oid")
                if not file or not oid:
                    continue
                evidence.append({
                    "file": file,
                    "hint": parse_claim_string(entry, "hint"),
                    "oid": oid,
                })
        claim["evidence"] = evidence
        for key in (
            "established",
            "verified",
            "retracted_at",
            "retracted_reason",
            "claim_oid",
        ):
            raw = re.search(rf"^{re.escape(key)}\s*=\s*(.+?)\s*$", body, re.M)
            if raw:
                value = raw.group(1)
                claim[key] = parse_claim_string(body, key) if value.startswith('"') else value
        claims[match.group(1)] = claim
    return claims


def load_claims_file(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    if tomllib is None:
        return {"claims": parse_claims_toml(text)}
    return tomllib.loads(text)


def atomic_write(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = (path.stat().st_mode & 0o777) if path.exists() else 0o644
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
        tmp = Path(handle.name)
    tmp.chmod(mode)
    tmp.replace(path)


# ------------------------------------------------------------------- git ---

def run_git(args, cwd=None, check=True):
    p = subprocess.run(["git", *args], cwd=cwd, capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    if check and p.returncode != 0:
        die(f"git {' '.join(args)} 失败: {p.stderr.strip()}")
    return p


def require_git():
    if not shutil.which("git"):
        print("✗ 未检测到 git。本工具的全部能力依赖 git（校验引擎/事件流/checkpoint）。")
        print("  安装指引：apt install git | dnf install git | brew install git"
              " | winget install --id Git.Git")
        print("  或运行: python3 wiki.py setup-env --auto")
        sys.exit(2)


def ensure_repo() -> str:
    """Return repo toplevel; offer git init when inside no repo."""
    require_git()
    p = run_git(["rev-parse", "--show-toplevel"], check=False)
    if p.returncode == 0:
        return p.stdout.strip()
    cwd = Path.cwd()
    if sys.stdin.isatty():
        ans = input(f"当前目录不在 git 仓库内。是否在 {cwd} 执行 git init? [y/N] ").strip().lower()
        if ans == "y":
            run_git(["init"], cwd=cwd)
            print("✓ 已初始化 git 仓库（建议随后完成首次 commit）")
            return str(cwd)
    die("需要 git 仓库：请先 git init，或进入仓库目录后重试")
    return ""


def repo_of(root: Path) -> str:
    return run_git(["rev-parse", "--show-toplevel"], cwd=str(root)).stdout.strip()


def working_oid(repo: str, rel: str):
    p = Path(repo) / rel
    if not p.is_file():
        return None
    out = run_git(["hash-object", "--", rel], cwd=repo).stdout.strip()
    return out or None


def index_oids(repo: str) -> dict:
    out = run_git(["ls-files", "-s", "-z"], cwd=repo).stdout
    m = {}
    for record in out.split("\0"):
        if not record:
            continue
        meta, rel = record.split("\t", 1)
        _mode, oid, stage = meta.split()
        m[rel] = oid if stage == "0" else None
    return m


def staged_files(repo: str) -> set:
    out = run_git(["diff", "--cached", "--name-only", "--no-renames", "-z"],
                  cwd=repo).stdout
    return {x for x in out.split("\0") if x}


def status_files(repo: str) -> set:
    out = run_git(["status", "--porcelain=v1", "-z"], cwd=repo).stdout
    files = set()
    records = [record for record in out.split("\0") if record]
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if len(record) < 4:
            continue
        state = record[:2]
        rel = record[3:]
        files.add(rel)
        if ("R" in state or "C" in state) and index < len(records):
            files.add(records[index])
            index += 1
    return files


def within_path(path: str, prefix: str) -> bool:
    candidate = PurePosixPath(path)
    root = PurePosixPath(prefix)
    return candidate == root or root in candidate.parents


def auto_commit(repo: str, paths, message: str, allow: bool = True):
    if not allow:
        return
    if isinstance(paths, str):
        paths = [paths]
    targets = [path for path in dict.fromkeys(paths) if path]
    if not targets:
        return
    st = run_git(["add", "--", *targets], cwd=repo, check=False)
    if st.returncode != 0:
        die(f"wiki 暂存失败：{(st.stderr or st.stdout).strip()}", 1)
    st = run_git(["commit", "-m", message, "--", *targets], cwd=repo, check=False)
    if st.returncode != 0:
        blob = (st.stdout + st.stderr).lower()
        if "nothing to commit" in blob or "no changes" in blob:
            return
        die(f"wiki 自动 commit 失败：{(st.stderr or st.stdout).strip()}", 1)


# ------------------------------------------------------------ root utils ---

def find_wiki_root() -> Path:
    cur = Path.cwd().resolve()
    for d in (cur, *cur.parents):
        if (d / "wiki" / "claims.toml").is_file():
            return d
    die("未找到 wiki root（wiki/claims.toml）。请先在项目根执行: wiki.py init")


def rel_wiki_of(root: Path) -> str:
    return os.path.relpath(root / "wiki", repo_of(root)).replace(os.sep, "/")


def load_context():
    root = find_wiki_root()
    repo = repo_of(root)
    claims_path = root / "wiki" / "claims.toml"
    data = load_claims_file(claims_path)
    return root, repo, data, claims_path


def save_and_commit(repo, root, claims_path, claims, msg, no_commit):
    atomic_write(claims_path, dump_claims(claims))
    auto_commit(repo, rel_wiki_of(root), msg, allow=not no_commit)
    last = run_git(["log", "-1", "--format=%h %s", "--", rel_wiki_of(root)],
                   cwd=repo, check=False).stdout.strip()
    if last:
        print(f"✓ wiki: {last}")


def all_roots(repo: str) -> list:
    out = run_git(["ls-files", "--cached", "--others", "--exclude-standard", "-z",
                   "--", "*/wiki/claims.toml", "wiki/claims.toml"],
                  cwd=repo).stdout
    roots = {
        Path(repo) / line
        for line in out.split("\0")
        if line and (line == "wiki/claims.toml" or line.endswith("/wiki/claims.toml"))
    }
    roots = {path.parent.parent for path in roots if path.is_file()}
    return sorted(roots)


def normalize_path(repo: str, p: str) -> str:
    ap = Path(p).resolve()
    try:
        return ap.relative_to(repo).as_posix()
    except ValueError:
        die(f"{p} 不在仓库内")


# ---------------------------------------------------------------- doctor ---

def collect_findings(repo, claims, source="worktree", staged=None, only_ids=None):
    """Return list of (level, claim_id, msg); level in MISSING/STALE."""
    findings = []
    idx = index_oids(repo) if source == "index" else None
    for cid, c in claims.items():
        if c.get("status") == "retracted":
            continue
        if only_ids and cid not in only_ids:
            continue
        for ev in c.get("evidence", []):
            f = ev.get("file", "")
            if staged is not None and f not in staged:
                continue
            if source == "index":
                actual = idx.get(f)
                if actual is None:
                    findings.append(("MISSING", cid, f"{f} 已被 staged 删除或未跟踪"))
                    continue
            else:
                actual = working_oid(repo, f)
                if actual is None:
                    findings.append(("MISSING", cid, f"{f} 不存在于工作区"))
                    continue
            if actual != ev.get("oid"):
                findings.append(("STALE", cid,
                                 f"{f}  {str(ev.get('oid'))[:8]}… → {actual[:8]}…"))
    return findings


def lint_wiki_docs(root: Path) -> list:
    warns = []
    wiki = root / "wiki"
    for md in wiki.rglob("*.md"):
        n = len(md.read_text(encoding="utf-8", errors="replace").splitlines())
        if n > LINE_WARN:
            rel = md.relative_to(root).as_posix()
            warns.append(("WARN", "docs", f"{rel} 共 {n} 行 (> {LINE_WARN}，应拆分)"))
    index = wiki / "INDEX.md"
    if index.is_file():
        text = index.read_text(encoding="utf-8", errors="replace")
        for m in re.finditer(r"\]\(([^)#]+?\.md)\)", text):
            target = (wiki / m.group(1)).resolve()
            if not target.is_file():
                warns.append(("WARN", "docs", f"INDEX 链接不可达: {m.group(1)}"))
    return warns


def print_findings(items):
    for level, cid, msg in items:
        print(f"{level:<8} {cid:<20} {msg}")


def summarize(claims, findings, warns):
    n = sum(1 for c in claims.values() if c.get("status") != "retracted")
    stale = sum(1 for lv, *_ in findings if lv == "STALE")
    missing = sum(1 for lv, *_ in findings if lv == "MISSING")
    print(f"summary: {n} claims, {stale} stale, {missing} missing, {len(warns)} warn")
    return missing, stale


def cmd_doctor(args):
    root, repo, data, _ = load_context()
    claims = data.get("claims", {})
    mode = ("staged" if args.staged else "git_status" if args.git_status
            else "ci" if args.ci else "all" if args.all_roots
            else "claim" if args.claim else "full")
    print(f"[wiki doctor] root={root}  mode={mode}")

    if args.git_status:
        changed = {f for f in status_files(repo)
                   if not within_path(f, rel_wiki_of(root))}
        by_file = {}
        for cid, c in claims.items():
            if c.get("status") == "retracted":
                continue
            for ev in c.get("evidence", []):
                by_file.setdefault(ev["file"], []).append(cid)
        hits = sorted({cid for f in changed for cid in by_file.get(f, [])})
        if hits:
            print("可能 stale 的 claims（evidence 出现在工作区变更中）:")
            for cid in hits:
                print(f"  - {cid}: {claims[cid].get('text', '')}")
            print(f"summary: {len(hits)} claims 待核验 (doctor --claim <id>)")
        else:
            print("summary: 工作区变更未触及任何 claim，初筛通过")
        return

    if args.staged:
        staged = staged_files(repo)
        if not staged:
            print("summary: 暂存区为空，门禁通过")
            return
        findings = []
        for candidate in all_roots(repo):
            candidate_claims_path = candidate / "wiki" / "claims.toml"
            candidate_data = load_claims_file(candidate_claims_path)
            candidate_claims = candidate_data.get("claims", {})
            current = collect_findings(repo, candidate_claims, source="index", staged=staged)
            if current:
                print(f"--- root: {candidate}")
                print_findings(current)
            findings.extend(current)
        if findings:
            die("提交门禁：以上 evidence 与 claim 声明不一致"
                "（重新 git add，或 wiki.py claim verify/update）", 1)
        print("✓ 提交门禁通过：staged 内容与 claims 声明一致")
        return

    if args.all_roots or args.ci:
        total_missing = 0
        for rr in all_roots(repo):
            print(f"--- root: {rr}")
            d = load_claims_file(rr / "wiki" / "claims.toml")
            cl = d.get("claims", {})
            fnd = collect_findings(repo, cl, source="worktree")
            warns = lint_wiki_docs(rr)
            print_findings(fnd + warns)
            m, _ = summarize(cl, fnd, warns)
            total_missing += m
        if args.ci and total_missing:
            sys.exit(1)
        if args.all_roots and total_missing:
            sys.exit(1)
        return

    only = {args.claim} if args.claim else None
    if only and args.claim not in claims:
        die(f"claim 不存在: {args.claim}")
    findings = collect_findings(repo, claims, source="worktree", only_ids=only)
    warns = [] if only else lint_wiki_docs(root)
    print_findings(findings + warns)
    missing, stale = summarize(claims, findings, warns)
    if mode == "ci" and missing:
        sys.exit(1)
    if missing:
        sys.exit(1)


# ----------------------------------------------------------------- claim ---

def ev_zip(evs, hints):
    if hints and len(hints) > len(evs):
        die("--hint 数量不能多于 --ev")
    out = []
    for i, e in enumerate(evs):
        out.append({"file": e, "hint": hints[i] if hints and i < len(hints) else None})
    return out


def compute_claim_oid(c) -> str:
    import hashlib
    basis = "\x1f".join([c["text"]] + [e["oid"] for e in c["evidence"]]
                        + [c.get("status", "active"), str(c.get("verified", ""))])
    return hashlib.sha256(basis.encode()).hexdigest()[:16]


def cmd_claim_add(args, no_commit):
    root, repo, data, path = load_context()
    claims = data.setdefault("claims", {})
    if not re.fullmatch(r"[A-Za-z0-9_-]+", args.id):
        die("claim id 只允许 [A-Za-z0-9_-]")
    if args.id in claims:
        die(f"claim 已存在: {args.id}（用 claim update）")
    text = args.text.strip()
    if not text:
        die("claim text 不能为空")
    evs = ev_zip([normalize_path(repo, e) for e in args.ev], args.hint)
    for e in evs:
        oid = working_oid(repo, e["file"])
        if oid is None:
            die(f"evidence 文件不存在: {e['file']}")
        e["oid"] = oid
    today = datetime.date.today().isoformat()
    c = {"text": text, "status": "active", "evidence": evs,
         "established": today, "verified": today}
    if args.claim_oid:
        c["claim_oid"] = compute_claim_oid(c)
    claims[args.id] = c
    save_and_commit(repo, root, path, claims,
                     f"wiki(claim): add {args.id}", no_commit)


def cmd_claim_verify(args, no_commit):
    root, repo, data, path = load_context()
    claims = data.get("claims", {})
    if args.changed or args.ids:
        if args.changed:
            plan = build_update_plan(root, repo, claims)
            ids = [row["id"] for row in plan["claims"]]
        else:
            ids = [cid.strip() for cid in args.ids.split(",") if cid.strip()]
        unknown = [cid for cid in ids if cid not in claims]
        if unknown:
            die(f"claim 不存在: {', '.join(unknown)}")
        if not ids:
            print("✓ 当前增量清单没有待核验 claim")
            return
        targets = {cid: claims[cid] for cid in ids}
    elif args.all:
        targets = claims
    else:
        target = claims.get(args.id)
        if target is None:
            die(f"claim 不存在: {args.id}")
        targets = {args.id: target}
    missing = []
    for cid, c in targets.items():
        if c.get("status") == "retracted":
            continue
        for ev in c.get("evidence", []):
            if working_oid(repo, ev["file"]) is None:
                missing.append((cid, ev["file"]))
    if missing:
        for cid, file in missing:
            print(f"✗ {cid}: evidence 缺失: {file}", file=sys.stderr)
        die("verify 失败：evidence 缺失时必须先 update 重挂证据或 retract", 1)
    today = datetime.date.today().isoformat()
    changed = 0
    for cid, c in targets.items():
        if c.get("status") == "retracted":
            if not args.all:
                print(f"- {cid}: retracted，跳过")
            continue
        touched = False
        for ev in c.get("evidence", []):
            oid = working_oid(repo, ev["file"])
            if oid != ev.get("oid"):
                ev["oid"] = oid
                touched = True
        c["verified"] = today
        if c.get("claim_oid"):
            c["claim_oid"] = compute_claim_oid(c)
        if touched:
            changed += 1
            print(f"✓ {cid}: oid 已刷新")
        elif not args.all:
            print(f"✓ {cid}: 无变化，verified 已标记")
    if changed or not args.all or args.changed or args.ids:
        label = (
            " --changed"
            if args.changed
            else f" --ids {args.ids}"
            if args.ids
            else " --all"
            if args.all
            else " " + str(args.id)
        )
        save_and_commit(repo, root, path, claims,
                         f"wiki(claim): verify{label}",
                         no_commit)


def cmd_claim_update(args, no_commit):
    root, repo, data, path = load_context()
    claims = data.get("claims", {})
    c = claims.get(args.id)
    if c is None:
        die(f"claim 不存在: {args.id}（用 claim add）")
    if args.text:
        text = args.text.strip()
        if not text:
            die("claim text 不能为空")
        c["text"] = text
    if args.ev:
        evs = ev_zip([normalize_path(repo, e) for e in args.ev], args.hint)
        for e in evs:
            oid = working_oid(repo, e["file"])
            if oid is None:
                die(f"evidence 文件不存在: {e['file']}")
            e["oid"] = oid
        c["evidence"] = evs
    else:
        for ev in c.get("evidence", []):
            oid = working_oid(repo, ev["file"])
            if oid is None:
                die(f"evidence 缺失: {ev['file']}（用 --ev 重挂证据）")
            ev["oid"] = oid
    c["status"] = "active"
    c["verified"] = datetime.date.today().isoformat()
    if args.claim_oid:
        c["claim_oid"] = compute_claim_oid(c)
    save_and_commit(repo, root, path, claims,
                     f"wiki(claim): update {args.id}", no_commit)


def cmd_claim_retract(args, no_commit):
    root, repo, data, path = load_context()
    claims = data.get("claims", {})
    c = claims.get(args.id)
    if c is None:
        die(f"claim 不存在: {args.id}")
    reason = args.reason.strip()
    if not reason:
        die("retract reason 不能为空")
    c["status"] = "retracted"
    c["retracted_at"] = datetime.date.today().isoformat()
    c["retracted_reason"] = reason
    save_and_commit(repo, root, path, claims,
                     f"wiki(claim): retract {args.id}", no_commit)
    print(f"- {args.id}: evidence 保留作历史参照，不再参与校验")


# ---------------------------------------------------------------- update ---

def last_wiki_checkpoint(repo: str, rel_wiki: str):
    """Return the last wiki commit that represents semantic work.

    Session activity commits are append-only telemetry. Treating them as the
    diff baseline would hide project commits made before SessionEnd, because
    the activity commit is created on top of those project commits.
    """
    out = run_git(
        ["log", "-50", "--format=%H%x00%s", "--", rel_wiki],
        cwd=repo,
        check=False,
    ).stdout
    for line in out.splitlines():
        commit, _, subject = line.partition("\0")
        if commit and subject != ACTIVITY_COMMIT_SUBJECT:
            return commit
    return ""


def build_update_plan(root: Path, repo: str, claims: dict) -> dict:
    rel_wiki = rel_wiki_of(root)
    ckpt = last_wiki_checkpoint(repo, rel_wiki)
    files = set()
    if ckpt:
        out = run_git(["diff", "--name-only", ckpt, "HEAD"], cwd=repo).stdout
        files |= {l for l in out.splitlines() if l}
    files |= status_files(repo)
    files = {f for f in files if not within_path(f, rel_wiki)}
    by_file = {}
    for cid, c in claims.items():
        if c.get("status") == "retracted":
            continue
        for ev in c.get("evidence", []):
            by_file.setdefault(ev["file"], []).append(cid)
    hits = sorted({cid for f in files for cid in by_file.get(f, [])})
    # oid 检测只读取 claims 的 evidence，不遍历项目。即使逐步提交 claim
    # 暂时移动了 checkpoint，也能找回仍未修复的 stale/missing 事实。
    findings = collect_findings(repo, claims, source="worktree")
    hits = sorted(set(hits) | {cid for _level, cid, _msg in findings})
    claim_rows = []
    for cid in hits:
        c = claims[cid]
        verdicts = []
        evidence = []
        for e in c.get("evidence", []):
            actual = working_oid(repo, e["file"])
            status = "missing" if actual is None else (
                "stale" if actual != e["oid"] else "active"
            )
            evidence.append({"file": e["file"], "status": status})
            if status != "active":
                verdicts.append(status.upper() + " " + e["file"])
        claim_rows.append({
            "id": cid,
            "text": c.get("text", ""),
            "evidence": evidence,
            "detail": "；".join(verdicts) or "oid 无变化（提交历史变化）",
        })
    return {
        "checkpoint": ckpt or None,
        "changed_files": sorted(files),
        "claims": claim_rows,
        "no_changes": not files and not claim_rows,
        # Explicit update may review any touched evidence. Automatic SessionEnd
        # only needs a model when an evidence oid is actually stale/missing;
        # claims already verified at the current oid should not re-trigger it.
        "needs_semantic_update": bool(findings),
    }


def cmd_update(args):
    root, repo, data, _ = load_context()
    claims = data.get("claims", {})
    payload = build_update_plan(root, repo, claims)
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
        return
    if not payload["claims"]:
        if payload["changed_files"]:
            print(
                f"✓ 检测到 {len(payload['changed_files'])} 个项目文件变化，"
                "但没有 evidence 命中任何 claim"
            )
            return
        print("✓ 自上次 checkpoint 以来没有触及任何 claim，无需修复")
        return
    print(f"自 checkpoint 起涉及 {len(payload['claims'])} 条 claim，逐条核验"
          f"（重读源文件 → verify / update / retract 三选一）:\n")
    for row in payload["claims"]:
        cid = row["id"]
        c = claims[cid]
        evs = ", ".join(e["file"] for e in c.get("evidence", []))
        print(f"- {cid}: {c.get('text', '')}\n    evidence: {evs}\n    状态: {row['detail']}")
    print(f"\n完成后执行 python3 {Path(__file__).resolve()} checkpoint")


# ------------------------------------------------------------ checkpoint ---

def refresh_recent(root: Path, repo: str, rel_wiki: str):
    idx = root / "wiki" / "INDEX.md"
    log = run_git(["log", "-8", "--format=- %h %ad %s",
                   "--date=format:%Y-%m-%d %H:%M:%S", "--", rel_wiki],
                  cwd=repo, check=False).stdout.strip()
    block = f"<!-- recent:start -->\n{log}\n<!-- recent:end -->"
    text = idx.read_text(encoding="utf-8") if idx.is_file() else ""
    if "<!-- recent:start -->" in text:
        text = re.sub(r"<!-- recent:start -->.*?<!-- recent:end -->",
                      block, text, flags=re.S)
    else:
        text = (text.rstrip() + "\n\n## 最近更新\n" + block + "\n") if text else \
               f"## 最近更新\n{block}\n"
    atomic_write(idx, text)


def cmd_checkpoint(args, no_commit):
    root, repo, data, _ = load_context()
    roots = all_roots(repo) if root.resolve() == Path(repo).resolve() else [root]
    claims_by_root = {}
    findings = []
    for candidate in roots:
        candidate_claims = load_claims_file(
            candidate / "wiki" / "claims.toml"
        ).get("claims", {})
        claims_by_root[candidate] = candidate_claims
        current = collect_findings(repo, candidate_claims, source="worktree")
        if current:
            print(f"--- root: {candidate}")
        findings.extend(current)
    if findings and not args.force:
        print_findings(findings)
        die("存在未修复漂移，拒绝打点。先跑 update --plan 修复，或 --force 带漂移打点", 1)

    wiki_prefixes = [rel_wiki_of(candidate) for candidate in roots]
    dirty = {
        path
        for path in status_files(repo)
        if not any(within_path(path, prefix) for prefix in wiki_prefixes)
    }
    if dirty:
        hit_claims = sorted({
            cid
            for candidate_claims in claims_by_root.values()
            for f in dirty
            for cid, c in candidate_claims.items()
            if c.get("status") != "retracted"
            for e in c.get("evidence", [])
            if e["file"] == f
        })
        if hit_claims:
            print(f"⚠ 未 commit 的工作区改动涉及 {len(hit_claims)} 条 claims: "
                  f"{', '.join(hit_claims)}")
            print("  （报告不代劳：请自行决定项目内容的提交时机）")

    for candidate in roots:
        refresh_recent(candidate, repo, rel_wiki_of(candidate))
    auto_commit(repo, wiki_prefixes, "wiki(checkpoint): sync state & index",
                allow=not no_commit)
    head = run_git(["log", "-1", "--format=%h %s", "--", *wiki_prefixes],
                   cwd=repo, check=False).stdout.strip()
    print(f"✓ checkpoint 完成: {head or '(wiki 无变更)'}")
    print("  下次会话从该点继续（INDEX.md 最近更新块已刷新）")


# ------------------------------------------------------------------- init ---

INDEX_TPL = """# {name}

> 项目摘要：TODO（做什么、给谁用、当前阶段）
> 项目类型：{stack}

## 速查
| 想知道 | 去哪 |
|---|---|
| 项目全貌与结构 | overview/architecture.md |
| 工作方式与约定 | overview/conventions.md |
| 常用流程与命令 | overview/commands.md |
| 环境、资源与交付 | overview/deployment.md |
| 当前进行中的事 | state/current.md |
| 历史决策 | overview/decisions/ |

## 红线（违反会损害结果或造成返工）
1. TODO

{module_map}
## 最近更新
<!-- recent:start -->
<!-- recent:end -->
"""

ARCH_TPL = """# 项目全貌与结构

> 适用于软件、研究、写作、设计、运营等任意项目。

## 目标与边界
TODO：项目解决什么问题、服务谁、当前阶段，以及明确不做什么。

## 当前内容
TODO：主要组成部分、参与者、关键对象和它们之间的关系。
TODO：关键工作流、信息流或交付流；有依赖时说明前后顺序。

## 约束与例外
TODO

## 来源与证据
TODO
"""

CONV_TPL = """# 工作方式与约定

> 适用于任意项目类型。记录团队如何协作、如何判断质量，以及不可违反的规则。

## 目标与边界
TODO：这些约定保护什么结果，适用于哪些人或工作范围。

## 当前内容
TODO：真实的工作原则、协作方式、命名或格式规则、评审与确认流程。

## 约束与例外
TODO：红线、允许的例外、例外由谁确认。

## 来源与证据
TODO：约定出自哪些文档、会议、样例或系统配置。
"""

DEPLOY_TPL = """# 环境、资源与交付

> 不限定软件部署。记录开展项目所需的环境、工具、资源，以及成果如何交付和维护。
{deploy_hint}
## 目标与边界
TODO：需要哪些环境、资源和交付条件，范围到哪里。

## 当前内容
TODO：环境与工具、账号或访问方式、素材与数据、发布或交付步骤。

## 约束与例外
TODO：安全、合规、权限、备份与回退要求，以及允许的例外。

## 来源与证据
TODO：配置、操作手册、平台页面或交付记录。
"""

CURRENT_TPL = """# 当前状态

## 现在
- 阶段：TODO
- 进行中：TODO

## 阻塞与风险
- 阻塞：无
- 风险：TODO

## 下一步
- TODO

## 最近变化
- TODO

## 会话活动
<!-- activity:start -->
<!-- activity:end -->
"""

LESSONS_TPL = """# 踩坑教训
<!-- 格式：- [日期] 教训（一句话）→ 规避动作 -->
"""

ADR_TPL = """# 决策记录（ADR）
<!-- 格式：## YYYY-MM-DD 决策标题
背景 / 备选 / 结论（为什么选 X 不选 Y） -->
"""

CLAIMS_TPL = CLAIMS_HEADER + "\n[claims]\n"


def clean_activity(value: str, limit: int) -> str:
    one_line = re.sub(r"\s+", " ", value or "").strip()
    return one_line.replace("|", "\\|")[:limit]


def write_activity(
    root: Path,
    repo: str,
    input_text: str,
    status_value: str,
    summary_text: str,
    no_commit: bool,
) -> dict:
    current = root / "wiki" / "state" / "current.md"
    text = current.read_text(encoding="utf-8") if current.is_file() else CURRENT_TPL
    match = re.search(
        re.escape(ACTIVITY_START) + r"(.*?)" + re.escape(ACTIVITY_END),
        text,
        re.S,
    )
    existing = []
    if match:
        existing = [
            line
            for line in match.group(1).splitlines()
            if line.strip().startswith("- ")
        ]
    stamp = datetime.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S")
    status = {"success": "成功", "failed": "失败", "aborted": "中止"}[status_value]
    request = clean_activity(input_text, 100)
    summary = clean_activity(summary_text, 180)
    activity = f"- {stamp} | {status} | {request}" + (f" | {summary}" if summary else "")
    lines = (existing + [activity])[-20:]
    block = (
        ACTIVITY_START
        + "\n"
        + "\n".join(lines)
        + ("\n" if lines else "")
        + ACTIVITY_END
    )
    if match:
        text = text[:match.start()] + block + text[match.end():]
    else:
        text = text.rstrip() + "\n\n## 会话活动\n" + block + "\n"
    atomic_write(current, text)
    current_rel = current.relative_to(Path(repo)).as_posix()
    auto_commit(
        repo,
        current_rel,
        ACTIVITY_COMMIT_SUBJECT,
        allow=not no_commit,
    )
    return {
        "at": stamp,
        "status": status_value,
        "input": request,
        "summary": summary,
    }


def cmd_record(args, no_commit):
    """Deterministically record a completed run in state/current.md."""
    root = find_wiki_root()
    repo = repo_of(root)
    activity = write_activity(root, repo, args.input, args.status, args.summary, no_commit)
    status = {"success": "成功", "failed": "失败", "aborted": "中止"}[args.status]
    request = activity["input"]
    print(f"✓ 已记录会话活动: {status} {request}")


def cmd_session_end(args, no_commit):
    """SessionEnd deterministic stage: plan first, then append activity.

    The plan is computed before the activity commit so the activity commit
    cannot hide project changes from the caller's incremental review.
    """
    root, repo, data, _ = load_context()
    claims = data.get("claims", {})
    plan = build_update_plan(root, repo, claims)
    activity = write_activity(
        root,
        repo,
        args.input,
        args.status,
        args.summary,
        no_commit,
    )
    payload = {**plan, "activity": activity}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
        return
    print(
        f"✓ 会话活动已记录；变更文件 {len(plan['changed_files'])} 个，"
        f"待核验 claim {len(plan['claims'])} 条"
    )


def detect_stack(repo: Path) -> str:
    found = []
    f = repo / "pyproject.toml"
    if f.is_file():
        try:
            import tomllib
            name = tomllib.loads(f.read_text(encoding="utf-8")) \
                .get("project", {}).get("name")
            found.append(f"Python ({name})" if name else "Python")
        except Exception:
            found.append("Python")
    f = repo / "package.json"
    if f.is_file():
        try:
            name = json.loads(f.read_text(encoding="utf-8")).get("name")
            found.append(f"Node.js ({name})" if name else "Node.js")
        except Exception:
            found.append("Node.js")
    f = repo / "go.mod"
    if f.is_file():
        m = re.search(r"^module\s+(\S+)", f.read_text(errors="replace"), re.M)
        found.append(f"Go ({m.group(1)})" if m else "Go")
    f = repo / "Cargo.toml"
    if f.is_file():
        try:
            import tomllib
            name = tomllib.loads(f.read_text(encoding="utf-8")) \
                .get("package", {}).get("name")
            found.append(f"Rust ({name})" if name else "Rust")
        except Exception:
            found.append("Rust")
    if (repo / "pom.xml").is_file():
        found.append("Java (Maven)")
    return "、".join(found) if found else "通用项目（未检测到技术清单）"


def extract_commands(repo: Path) -> str:
    sections = []
    f = repo / "Makefile"
    if f.is_file():
        targets = []
        for ln in f.read_text(errors="replace").splitlines():
            m = re.match(r"^([a-zA-Z][\w.-]*):(?:\s|$)", ln)
            if m and m.group(1) not in targets:
                targets.append(m.group(1))
        if targets:
            sections.append("### Make\n" +
                            "\n".join(f"- `make {t}`" for t in targets[:25]))
    f = repo / "package.json"
    if f.is_file():
        try:
            scripts = json.loads(f.read_text(encoding="utf-8")).get("scripts", {})
            if scripts:
                sections.append("### npm scripts\n" + "\n".join(
                    f"- `{k}` → `{v}`" for k, v in list(scripts.items())[:25]))
        except Exception:
            pass
    f = repo / "justfile"
    if not f.is_file():
        f = repo / "Justfile"
    if f.is_file():
        recipes = []
        for ln in f.read_text(errors="replace").splitlines():
            m = re.match(r"^@?([a-zA-Z][\w-]*)(?:\s+\S.*)?:", ln)
            if m and m.group(1) not in recipes:
                recipes.append(m.group(1))
        if recipes:
            sections.append("### just\n" +
                            "\n".join(f"- `just {t}`" for t in recipes[:25]))
    if (repo / "Taskfile.yml").is_file():
        tasks = []
        in_tasks = False
        for line in (repo / "Taskfile.yml").read_text(errors="replace").splitlines():
            if re.match(r"^tasks:\s*$", line):
                in_tasks = True
                continue
            if in_tasks and line and not line.startswith(" "):
                break
            match = re.match(r"^  ([A-Za-z0-9_.-]+):\s*$", line) if in_tasks else None
            if match:
                tasks.append(match.group(1))
        if tasks:
            sections.append("### Task\n" + "\n".join(f"- `task {name}`" for name in tasks))
        else:
            sections.append("### Task\nTODO（检测到 Taskfile.yml，请手填常用任务）")
    return "\n\n".join(sections) or "TODO（未检测到任务定义文件，请手填常用命令）"


def detect_deploy(repo: Path) -> str:
    hints = []
    if (repo / ".github" / "workflows").is_dir():
        hints.append("- 检测到 .github/workflows/（CI 在 GitHub Actions）")
    if (repo / "Dockerfile").is_file():
        hints.append("- 检测到 Dockerfile")
    if (repo / "helm").is_dir() or (repo / "charts").is_dir():
        hints.append("- 检测到 helm chart")
    k8s = repo / "k8s"
    if k8s.is_dir():
        hints.append("- 检测到 k8s/ 目录")
    return ("\n".join(hints) + "\n") if hints else ""


def detect_modules(repo: Path) -> list:
    mods = []
    manifests = ("package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml")
    for d in ("services", "apps", "packages"):
        base = repo / d
        if base.is_dir():
            for child in sorted(base.iterdir()):
                if child.is_dir() and any((child / m).is_file() for m in manifests):
                    mods.append(child.relative_to(repo).as_posix())
    f = repo / "package.json"
    if f.is_file():
        try:
            for w in json.loads(f.read_text(encoding="utf-8")).get("workspaces", []):
                for hit in sorted(repo.glob(w)):
                    if hit.is_dir() and (hit / "package.json").is_file():
                        rel = hit.relative_to(repo).as_posix()
                        if rel not in mods:
                            mods.append(rel)
        except Exception:
            pass
    f = repo / "pnpm-workspace.yaml"
    if f.is_file():
        for ln in f.read_text(errors="replace").splitlines():
            m = re.match(r"\s*-\s*['\"]?([^'\"#\n]+)", ln)
            if m:
                for hit in sorted(repo.glob(m.group(1).strip())):
                    if hit.is_dir():
                        rel = hit.relative_to(repo).as_posix()
                        if rel not in mods:
                            mods.append(rel)
    f = repo / "go.work"
    if f.is_file():
        text = f.read_text(errors="replace")
        go_uses = re.findall(r"^\s*use\s+([^\s(]+)", text, re.M)
        block_match = re.search(r"^\s*use\s*\((.*?)^\s*\)", text, re.M | re.S)
        if block_match:
            go_uses.extend(
                re.findall(r"^\s*([^\s()]+)", block_match.group(1), re.M)
            )
        for value in go_uses:
            hit = (repo / value.strip().strip('"')).resolve()
            if hit.is_dir() and hit.is_relative_to(repo):
                rel = hit.relative_to(repo).as_posix()
                if rel not in mods:
                    mods.append(rel)
    return mods


def write_if_missing(path: Path, content: str) -> bool:
    if path.exists():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(path, content)
    return True


def install_hook(root: Path) -> str:
    configured = run_git(["config", "--get", "core.hooksPath"],
                         cwd=str(root), check=False).stdout.strip()
    husky_script = root / ".husky" / "pre-commit"
    if husky_script.is_file():
        hook = husky_script
    elif configured:
        hooks_dir = Path(configured)
        if not hooks_dir.is_absolute():
            hooks_dir = root / hooks_dir
        hook = hooks_dir / "pre-commit"
    else:
        gd = run_git(["rev-parse", "--git-dir"], cwd=str(root)).stdout.strip()
        git_dir = Path(gd) if Path(gd).is_absolute() else (root / gd)
        hook = git_dir / "hooks" / "pre-commit"
    line = f'"{sys.executable}" "{Path(__file__).resolve()}" doctor --staged'
    hook.parent.mkdir(parents=True, exist_ok=True)
    if hook.exists():
        text = hook.read_text(encoding="utf-8", errors="replace")
        pattern = re.escape(HOOK_MARK) + r"\n[^\n]*"
        updated = re.sub(pattern, f"{HOOK_MARK}\n{line}", text, count=1)
        if updated == text and HOOK_MARK in text:
            return "already"
        if HOOK_MARK in text:
            atomic_write(hook, updated)
            hook.chmod(0o755)
            return "updated"
        atomic_write(hook, text.rstrip() + f"\n{HOOK_MARK}\n{line}\n")
    else:
        atomic_write(hook, f"#!/bin/sh\n{HOOK_MARK}\n{line}\n")
    hook.chmod(0o755)
    return "installed"


AGENTS_BLOCK = """{mark_start}
# Agent 指南（project-wiki）
- 项目知识库在 wiki/INDEX.md，会话开始必读；开始工作前先查对应项目 wiki
- wiki 读写协议见 {skill_ref}/SKILL.md
- 工具：python3 "{script}"（不要手改 wiki/claims.toml）
- 项目地图见 wiki/INDEX.md
{mark_end}
"""


def update_agents_md(root: Path) -> str:
    script = Path(__file__).resolve()
    try:
        skill_ref = script.parent.parent.relative_to(root).as_posix()
    except ValueError:
        skill_ref = str(script.parent.parent)
        print(f"⚠ skill 安装在仓库外，AGENTS.md 将写入绝对路径: {skill_ref}")
    agents = root / "AGENTS.md"
    block = AGENTS_BLOCK.format(mark_start=AGENTS_MARK_START,
                                mark_end=AGENTS_MARK_END,
                                skill_ref=skill_ref, script=script)
    if agents.exists():
        text = agents.read_text(encoding="utf-8", errors="replace")
        if AGENTS_MARK_START in text:
            pattern = re.escape(AGENTS_MARK_START) + r".*?" + re.escape(AGENTS_MARK_END)
            updated = re.sub(pattern, block.rstrip(), text, flags=re.S)
            if updated == text:
                return "already"
            atomic_write(agents, updated)
            return "updated"
        atomic_write(agents, text.rstrip() + "\n\n" + block)
        return "appended"
    atomic_write(agents, block)
    return "created"


MODULE_AGENTS_BLOCK = """{mark_start}
# Agent 指南（project-wiki）
- 本部分知识库在 wiki/INDEX.md，开始工作前先查
- 全局知识库与协议见仓库根 AGENTS.md
{mark_end}
"""


def update_module_agents(mod_root: Path) -> str:
    agents = mod_root / "AGENTS.md"
    block = MODULE_AGENTS_BLOCK.format(mark_start=AGENTS_MARK_START,
                                       mark_end=AGENTS_MARK_END)
    if agents.exists():
        text = agents.read_text(encoding="utf-8", errors="replace")
        if AGENTS_MARK_START in text:
            pattern = re.escape(AGENTS_MARK_START) + r".*?" + re.escape(AGENTS_MARK_END)
            updated = re.sub(pattern, block.rstrip(), text, flags=re.S)
            if updated == text:
                return "already"
            atomic_write(agents, updated)
            return "updated"
        atomic_write(agents, text.rstrip() + "\n\n" + block)
        return "appended"
    atomic_write(agents, block)
    return "created"


def gen_module_wiki(mod_root: Path, repo_root: Path):
    created_wiki = []
    created_agents = []
    rel = mod_root.relative_to(repo_root).as_posix()
    files = {
        "wiki/INDEX.md": (
            f"# {mod_root.name}\n\n> 模块 wiki（上级全局: "
            f"{os.path.relpath(repo_root / 'wiki' / 'INDEX.md', mod_root)}）\n\n"
            "## 项目速查\nTODO\n"
        ),
        "wiki/claims.toml": CLAIMS_TPL,
        "wiki/overview/architecture.md": f"# {rel} 项目结构与关系\nTODO\n",
        "wiki/state/current.md": CURRENT_TPL,
        "wiki/state/lessons/README.md": LESSONS_TPL,
    }
    for relative, content in files.items():
        if write_if_missing(mod_root / relative, content):
            created_wiki.append((mod_root / relative).relative_to(repo_root).as_posix())
    if update_module_agents(mod_root) != "already":
        created_agents.append((mod_root / "AGENTS.md").relative_to(repo_root).as_posix())
    return created_wiki, created_agents


def cmd_init(args, no_commit):
    repo = ensure_repo()
    root = Path(repo)
    wiki = root / "wiki"

    created = []
    created_wiki_paths = []
    created_agent_paths = []
    name = root.name
    stack = detect_stack(root)
    mods = detect_modules(root)
    module_map = ""
    if mods:
        rows = "\n".join(
            f"| {m} | TODO | TODO | "
            f"{('[AGENTS.md](../' + m + '/AGENTS.md)') if args.per_module else '未初始化'} |"
            for m in mods
        )
        module_map = ("\n## 项目地图\n| 路径 | 职责 | 主要输入或产出 | 项目 wiki |\n"
                      "|---|---|---|---|\n" + rows + "\n")

    for rel, content in [
        ("wiki/INDEX.md", INDEX_TPL.format(name=name, stack=stack, module_map=module_map)),
        ("wiki/overview/architecture.md", ARCH_TPL),
        ("wiki/overview/conventions.md", CONV_TPL),
        ("wiki/overview/commands.md",
         "# 常用流程与命令\n\n"
         "> 同时记录人工流程与可执行命令；没有命令的项目可以只写步骤。\n\n"
         "## 工作流程\nTODO\n\n"
         f"## 可执行入口\n{extract_commands(root)}\n\n"
         "## 来源与证据\nTODO\n"),
        ("wiki/overview/deployment.md",
         DEPLOY_TPL.format(deploy_hint=detect_deploy(root))),
        ("wiki/overview/decisions/README.md", ADR_TPL),
        ("wiki/state/current.md", CURRENT_TPL),
        ("wiki/state/lessons/README.md", LESSONS_TPL),
        ("wiki/claims.toml", CLAIMS_TPL),
    ]:
        if write_if_missing(root / rel, content):
            created.append(rel)
            created_wiki_paths.append(rel)

    if args.per_module and mods:
        for m in mods:
            wiki_paths, agent_paths = gen_module_wiki(root / m, root)
            created_wiki_paths.extend(wiki_paths)
            created_agent_paths.extend(agent_paths)
            created.extend(wiki_paths + agent_paths)

    ag = update_agents_md(root)
    if ag != "already":
        created_agent_paths.append("AGENTS.md")
    hk = install_hook(root)
    if os.name == "nt":
        print("⚠ Windows 下 git hook 依赖 Git for Windows 的 sh；"
              "建议同时以 CI doctor --ci 兜底")

    if not no_commit and created_wiki_paths:
        auto_commit(repo, created_wiki_paths, "wiki(init): scaffold knowledge base")
    if not no_commit and created_agent_paths:
        auto_commit(repo, created_agent_paths, "wiki(init): add AGENTS.md pointers")

    print(f"\n✓ init 完成：新建 {len(created)} 项；"
          f"AGENTS.md: {ag}；pre-commit hook: {hk}")
    print(f"  项目类型: {detect_stack(root)}")
    if mods:
        print(f"  monorepo 模块: {', '.join(mods)}")
    print(
        "\n—— 首会话引导（可整段粘贴给 agent）——\n"
        "请阅读 wiki/INDEX.md 与 wiki/overview/ 下的 TODO，完成以下冷启动：\n"
        "1. 了解项目内容与工作方式，填写 architecture.md、conventions.md、commands.md、"
        "deployment.md（只写无法从材料直接看出、值得复用的信息）\n"
        "2. 补全 INDEX.md 的项目摘要、项目地图与红线\n"
        f"3. 为核心机制建立首批 claims：python3 {Path(__file__).resolve()} "
        "claim add --id <slug> --text \"...\" --ev <文件>\n"
        "完成后执行 checkpoint。"
    )


# -------------------------------------------------------------- setup-env ---

def cmd_setup_env(args):
    if shutil.which("git"):
        out = subprocess.run(["git", "--version"], capture_output=True,
                             text=True).stdout.strip()
        print(f"✓ {out}")
        return
    plat = sys.platform
    if plat == "darwin":
        cmd = "brew install git"
    elif plat == "win32":
        cmd = "winget install --id Git.Git -e"
    elif os.path.exists("/etc/os-release"):
        rel = Path("/etc/os-release").read_text(errors="replace").lower()
        if "almalinux" in rel or "rocky" in rel or "rhel" in rel or "fedora" in rel or "centos" in rel:
            cmd = "dnf install -y git"
        elif "arch" in rel:
            cmd = "pacman -S --noconfirm git"
        else:
            cmd = "apt-get install -y git"
    else:
        die("未知平台，请手动安装 git")
    print(f"安装命令: {cmd}")
    if args.auto:
        if cmd.startswith("apt"):
            if os.geteuid() != 0:
                die("apt 安装需要 root（sudo 或容器内执行）", 2)
        print(f"$ {cmd}")
        sys.exit(subprocess.call(cmd, shell=True))
    print("或重新运行: python3 wiki.py setup-env --auto")


# -------------------------------------------------------------------- main ---

def main():
    ap = argparse.ArgumentParser(prog="wiki.py",
                                 description="git-anchored project wiki for agents")
    ap.add_argument("--version", action="version",
                    version=f"project-wiki {__version__}")
    ap.add_argument("--no-commit", action="store_true",
                    help="写操作不自动 commit（攒着和项目内容一起提交时用）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init", help="初始化 wiki/ 骨架 + AGENTS.md + hook")
    p.add_argument("--per-module", action="store_true",
                   help="monorepo：为每个模块生成嵌套 wiki")

    p = sub.add_parser("claim")
    c = p.add_subparsers(dest="ccmd", required=True)
    ca = c.add_parser("add")
    ca.add_argument("--id", required=True)
    ca.add_argument("--text", required=True)
    ca.add_argument("--ev", action="append", required=True)
    ca.add_argument("--hint", action="append")
    ca.add_argument("--claim-oid", action="store_true")
    cv = c.add_parser("verify")
    g = cv.add_mutually_exclusive_group(required=True)
    g.add_argument("--id")
    g.add_argument("--all", action="store_true")
    g.add_argument(
        "--changed",
        action="store_true",
        help="批量核验当前增量清单命中的 claims，一次刷新 oid",
    )
    g.add_argument(
        "--ids",
        help="逗号分隔的 claim id，一次核验并刷新 oid",
    )
    cu = c.add_parser("update")
    cu.add_argument("--id", required=True)
    cu.add_argument("--text", required=True)
    cu.add_argument("--ev", action="append")
    cu.add_argument("--hint", action="append")
    cu.add_argument("--claim-oid", action="store_true")
    cr = c.add_parser("retract")
    cr.add_argument("--id", required=True)
    cr.add_argument("--reason", required=True)

    p = sub.add_parser("doctor")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--all", dest="all_roots", action="store_true")
    g.add_argument("--claim")
    g.add_argument("--git-status", action="store_true")
    g.add_argument("--staged", action="store_true")
    g.add_argument("--ci", action="store_true")

    p = sub.add_parser("update", help="漂移修复工作清单")
    p.add_argument("--plan", action="store_true")
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("record", help="把一次项目 run 确定性写入 state/current.md")
    p.add_argument("--input", required=True)
    p.add_argument("--status", choices=("success", "failed", "aborted"), required=True)
    p.add_argument("--summary", default="")

    p = sub.add_parser(
        "session-end",
        help="SessionEnd 确定性收尾：先产出增量清单，再记录会话活动",
    )
    p.add_argument("--input", required=True)
    p.add_argument("--status", choices=("success", "failed", "aborted"), required=True)
    p.add_argument("--summary", default="")
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("checkpoint")
    p.add_argument("--force", action="store_true")

    p = sub.add_parser("setup-env")
    p.add_argument("--auto", action="store_true")

    sub.add_parser("root")

    args = ap.parse_args()

    if args.cmd == "setup-env":
        cmd_setup_env(args)
        return
    if sys.version_info < (3, 9):
        die("需要 Python >= 3.9")

    if args.cmd == "init":
        cmd_init(args, args.no_commit)
    elif args.cmd == "root":
        print(find_wiki_root())
    elif args.cmd == "claim":
        {"add": cmd_claim_add, "verify": cmd_claim_verify,
         "update": cmd_claim_update, "retract": cmd_claim_retract}[args.ccmd](
            args, args.no_commit)
    elif args.cmd == "doctor":
        cmd_doctor(args)
    elif args.cmd == "update":
        cmd_update(args)
    elif args.cmd == "record":
        cmd_record(args, args.no_commit)
    elif args.cmd == "session-end":
        cmd_session_end(args, args.no_commit)
    elif args.cmd == "checkpoint":
        cmd_checkpoint(args, args.no_commit)


if __name__ == "__main__":
    main()
