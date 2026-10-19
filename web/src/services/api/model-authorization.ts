import { cloudApi } from "./cloud";

export type AuthorizationResume = { returnTo: string; draft: unknown; result: string; message: string; recoverable?: boolean };
export const recoverModelAuthorization = () => cloudApi<AuthorizationResume | null>("/model-authorization/recover", { method: "POST" });
