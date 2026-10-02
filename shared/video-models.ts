export const videoModelTypes = ["seedance", "wan"] as const;
export type VideoModelType = (typeof videoModelTypes)[number];
export const videoModelTypeLabels: Record<VideoModelType, string> = { seedance: "Seedance", wan: "WAN 3" };

export function wanModelProfile(model: string) {
    const match = /^wan3\.0-(video|image)(?:-prime)?-(480|720|1080)p$/.exec(model);
    return match ? { referenceVideo: match[1] === "video", resolution: match[2] } : null;
}
