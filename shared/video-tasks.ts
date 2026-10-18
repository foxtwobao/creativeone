import type { VideoModelType } from "./video-models.js";

export const VIDEO_POLL_INTERVAL_MS = 5_000;
export const VIDEO_WORKER_INTERVAL_MS = 10_000;
export type VideoTaskPath = "videos" | "contents/generations/tasks";
export const videoTaskPath = (family: VideoModelType): VideoTaskPath => family === "seedance" ? "contents/generations/tasks" : "videos";

