import type { RequestHandler } from "express";
import { z } from "zod";

export class HttpError extends Error {
    constructor(public status: number, public code: string) { super(code); }
}
export const requireUuid = (value: unknown) => z.uuid().parse(value);
export const requireKey = (value: unknown) => z.string().regex(/^[\w:.-]+$/).parse(value);
export const noCache: RequestHandler = (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
};
