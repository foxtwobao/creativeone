import { FileText, ImagePlus, Images, Maximize2, Settings2, Video } from "lucide-react";
import { features } from "./features";

const tools = [
    {
        slug: "canvas",
        icon: Maximize2,
    },
    {
        slug: "image",
        icon: ImagePlus,
    },
    {
        slug: "video",
        icon: Video,
    },
    {
        slug: "prompts",
        icon: FileText,
    },
    {
        slug: "assets",
        icon: Images,
    },
    {
        slug: "config",
        icon: Settings2,
    },
] as const;

export const navigationTools = tools.filter(({ slug }) => (slug !== "canvas" || features.canvas) && (slug !== "video" || features.video));
export type NavigationToolSlug = (typeof tools)[number]["slug"];
