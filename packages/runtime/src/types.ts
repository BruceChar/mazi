import { Goal } from "@mazi/core";

export interface Session {
    sessionId: string;
    name: string;
    goals: Goal[];
    createdAt: number;
    updatedAt: number;
}

export interface Conversation {
    conversationId: string;
    name: string;
    projectId?: string;
    workspace?: string;
    sessions: Session[];
    createdAt: number;
    updatedAt: number;
}