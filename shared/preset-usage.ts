export type PresetModelUsage = { model: string; enabled: boolean };
export type PresetListItem<T> = T & { usedBy: PresetModelUsage[] };
