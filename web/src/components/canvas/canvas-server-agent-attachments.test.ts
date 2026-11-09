import { describe, expect, test } from "bun:test";
import { clipboardFiles } from "./canvas-agent-clipboard";

describe("clipboardFiles",()=>{
    test("uses clipboard files when available",()=>{
        const image=new File(["image"],"image.png",{type:"image/png"});
        const item={kind:"file",getAsFile:()=>new File(["item"],"item.png",{type:"image/png"})};
        const data={files:[image],items:[item]} as unknown as DataTransfer;
        expect(clipboardFiles(data)).toEqual([image]);
    });
    test("reads file items when the clipboard files list is empty",()=>{
        const media=new File(["audio"],"voice.mp3",{type:"audio/mpeg"});
        const data={files:[],items:[{kind:"string",getAsFile:()=>null},{kind:"file",getAsFile:()=>media}]} as unknown as DataTransfer;
        expect(clipboardFiles(data)).toEqual([media]);
    });
    test("ignores string clipboard items and unavailable files",()=>{
        const data={files:[],items:[{kind:"string",getAsFile:()=>null},{kind:"file",getAsFile:()=>null}]} as unknown as DataTransfer;
        expect(clipboardFiles(data)).toEqual([]);
    });
});
