import { z } from "zod";
import { jsonSchema, zodSchema, type JSONSchema7 } from "ai";
import { audioInputSchema } from "../audio.js";
import type { VideoProfile } from "../../../shared/video-models.js";
import { HttpError } from "../http.js";
import type { Run } from "./state.js";
import type { AgentConfig } from "./config.js";

export class ToolParameterError extends HttpError {
    constructor(public explanation:string,code="MODEL_CAPABILITY_INVALID") {super(400,code);}
}
export const mediaModelAllowed=(run:Run,config:AgentConfig,model:string)=>run.model_config.limits.verifiedMediaModels.includes(model)&&config.verifiedMediaModels.includes(model);

// Null means an omitted optional parameter; never coerce strings, booleans or IDs.
export const optionalToolParam=<T extends z.ZodType>(schema:T,fallback?:z.output<T>)=>schema.nullish().transform(value=>value??fallback);
export const reasoningEffort=z.enum(["auto","low","medium","high","xhigh"]);
export const mediaParams=z.object({
    reasoningEffort:optionalToolParam(reasoningEffort),
    size:optionalToolParam(z.string().describe("仅图片尺寸或画幅；视频请用 videoSize")),quality:optionalToolParam(z.string()),background:optionalToolParam(z.string()),
    videoSize:optionalToolParam(z.string().describe("视频画幅，例如 16:9；不是 ratio 或 size")),
    seconds:optionalToolParam(z.string().regex(/^(?:-1|[1-9]\d*)$/,"视频时长必须为整数字符串；仅模型支持时可用 -1").describe("视频时长使用整数字符串，例如 3；不支持 2.5 秒")),
    vquality:optionalToolParam(z.string().describe("视频分辨率，使用能力列表中的值，例如 720、1080")),
    videoMode:optionalToolParam(z.enum(["frames","reference"])),generateAudio:optionalToolParam(z.enum(["true","false"])),watermark:optionalToolParam(z.enum(["true","false"])),fastMode:optionalToolParam(z.enum(["true","false"])),audioInput:optionalToolParam(audioInputSchema),
}).strict();
export const videoToolParameterError=(profile:VideoProfile,parameters:Record<string,unknown>)=>
    !profile.durationConfigurable && parameters.seconds!==undefined ? "当前视频模型的时长由模型决定，请省略 seconds 或传 null。" :
    !profile.audioOptions && (parameters.generateAudio!==undefined || parameters.watermark!==undefined) ? "当前视频模型不提供生成音频或水印参数，请省略 generateAudio、watermark 或传 null。" :
    !profile.fastModeOptions && parameters.fastMode!==undefined ? "当前参数预设不提供标准／优先模式，请省略 fastMode 或传 null。" : "";

export const toolJsonSchema=(input:z.ZodType,strict=true)=>z.toJSONSchema(input,{target:"draft-7",io:"input",reused:"inline",override:({jsonSchema:schema})=>{
    if(strict&&schema.properties)schema.required=Object.keys(schema.properties);
    // Tagged union branches remain disjoint; strict function calling uses anyOf.
    if(schema.oneOf){schema.anyOf=schema.oneOf;delete schema.oneOf;}
    delete schema.default;
}}) as JSONSchema7;
export const strictToolInput=(input:z.ZodType)=>jsonSchema(toolJsonSchema(input),{validate:zodSchema(input).validate});
