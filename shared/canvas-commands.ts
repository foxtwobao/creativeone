export function canvasPresentationOnly(command: { type: string; patch?: object; graphEdits?: unknown[] }) {
    return command.type === "edit_project" && command.graphEdits?.length === 0
        && Object.keys(command.patch || {}).every(key => ["viewport", "backgroundMode", "showImageInfo"].includes(key));
}
