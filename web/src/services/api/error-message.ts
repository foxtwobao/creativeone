const detailsSeparator = "\n\n错误详情\n";

export function cloudErrorMessage(value: unknown): string {
    if (!value || typeof value !== "object") return "";
    const body = value as { error?: unknown; message?: unknown; requestId?: unknown };
    if (typeof body.error !== "string" || typeof body.requestId !== "string" || typeof body.message !== "string") return "";
    return `${body.message}${detailsSeparator}错误码：${body.error}\n请求 ID：${body.requestId}`;
}

export function splitErrorMessage(error: string) {
    const index = error.indexOf(detailsSeparator);
    return index < 0 ? { message: error, details: "" } : { message: error.slice(0, index), details: error.slice(index + detailsSeparator.length) };
}
