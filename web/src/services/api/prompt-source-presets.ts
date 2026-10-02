import { nanoid } from "nanoid";
import type { PromptSource } from "../../../../shared/prompt-sources";
export { DEFAULT_PROMPT_SOURCES, PROMPT_REGISTRY_HOMEPAGE, type PromptSource } from "../../../../shared/prompt-sources";
export function createPromptSource(source?: Partial<PromptSource>): PromptSource {
    return {
        id: source?.id?.trim() || nanoid(),
        name: source?.name?.trim() || "",
        url: source?.url?.trim() || "",
        homepage: source?.homepage?.trim() || "",
        enabled: source?.enabled ?? true,
        builtIn: source?.builtIn ?? false,
    };
}

