<script setup>
defineProps({
    name: { type: String, required: true },
    size: { type: Number, default: 16 },
});

const paths = {
    menu: 'M3 6h18M3 12h18M3 18h18',
    search: 'M15.5 15.5L21 21M9 17a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z',
    plus: 'M12 4v16M4 12h16',
    panel: 'M4 5h16v14H4zM14 5v14',
    sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4',
    moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1A2 2 0 1 1 4.2 17l.1-.1A1.7 1.7 0 0 0 3.1 14a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1A2 2 0 1 1 7 4.2l.1.1a1.7 1.7 0 0 0 2.9-1.2 2 2 0 1 1 4 0A1.7 1.7 0 0 0 16.9 4.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0 1.2 2.9 2 2 0 1 1 0 4 1.7 1.7 0 0 0-1.5 1Z',
    userMessage: 'M8 20V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v14M12 4v8M8 9h8',
    thinking: 'M4 6h11M4 10h11M4 14h7M17 10l4 4-4 4',
    tool: 'M14.5 9.5l5-5-4-4-5 5a5 5 0 0 0-6.2 6.2L2 14v4h4l2.3-2.3A5 5 0 0 0 14.5 9.5Z',
    observation: 'M6 3h12v18l-6-4-6 4zM9 8h6M9 12h6',
    copy: 'M9 9h11v11H9zM4 15V4h11',
    play: 'M7 4l12 8-12 8z',
    refresh: 'M20 12a8 8 0 1 1-3.2-6.4M20 4v5h-5',
    like: 'M6 20V10l5-7c2.8.4 3.5 2.2 2.2 5H19a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 17.6 20z',
    dislike: 'M18 4v10l-5 7c-2.8-.4-3.5-2.2-2.2-5H5a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 6.4 4z',
    send: 'M4 12l17-8-7 17-2-7z',
    close: 'M5 5l14 14M19 5L5 19',
    chevronDown: 'M5 9l7 7 7-7',
    chevronRight: 'M9 5l7 7-7 7',
    rename: 'M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17zM14.5 6.5l3 3',
    archive: 'M4 8h16M6 8v11h12V8M4 4h16v4H4z',
    restore: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v5h5',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6',
};
</script>

<template>
    <svg
        class="line-icon"
        :width="size"
        :height="size"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
    >
        <path :d="paths[name]" />
    </svg>
</template>
