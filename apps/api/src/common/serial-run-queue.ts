interface QueuedOperation {
    start: () => Promise<void>;
    reject: (reason: unknown) => void;
}

/**
 * FIFO serial queue for foreground Goal execution.
 * A rejected operation releases the queue without preventing later work.
 */
export class SerialRunQueue {
    private readonly queue: QueuedOperation[] = [];
    private running = false;
    private closed = false;

    get isRunning(): boolean {
        return this.running;
    }

    get pendingCount(): number {
        return this.queue.length;
    }

    run<T>(operation: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            if (this.closed) {
                reject(new Error('执行队列已关闭'));
                return;
            }
            this.queue.push({
                start: async () => {
                    try {
                        resolve(await operation());
                    } catch (error) {
                        reject(error);
                    }
                },
                reject,
            });
            this.startNext();
        });
    }

    close(reason: unknown = new Error('执行队列已关闭')): void {
        if (this.closed) return;
        this.closed = true;
        for (const operation of this.queue.splice(0)) {
            operation.reject(reason);
        }
    }

    private startNext(): void {
        if (this.running || this.closed) return;
        const operation = this.queue.shift();
        if (operation === undefined) return;
        this.running = true;
        void operation.start().finally(() => {
            this.running = false;
            this.startNext();
        });
    }
}
