export const agentPhases={intake:"理解目标",concept:"构思方案",script:"剧本创作",breakdown:"拆解需求",references:"素材准备",storyboard:"分镜设计",video:"视频创作",audio:"声音创作",review:"检查整理",complete:"本阶段完成"} as const;
export const agentImageInputNotice="当前推理模型未启用图片理解；可读取节点正文、参数和文件信息，也可绑定原图作为生成参考，但不能判断画面内容。";
export const agentPresets=[
    {id:"script",title:"写剧本",description:"从想法到故事",skills:["script"],goal:"请和我一起创作剧本。先确认题材、用途和目标时长，再保存我确认的正文；不要直接生成媒体。"},
    {id:"breakdown",title:"拆分镜",description:"节奏、画面与声音",skills:["script"],goal:"请读取选中剧本，拆解镜头、画面动作、运镜、声音和素材需求，保存为分镜文本。缺少目标时长先询问。"},
    {id:"character",title:"角色设定",description:"人物与视觉参考",skills:["image_character_sheet"],goal:"请根据选中内容设计角色参考方案，沿用已确认的人物设定；先核对需要的参考图，再准备图片节点供我确认。"},
    {id:"storyboard",title:"分镜图",description:"把镜头变成画面",skills:["image_storyboard"],goal:"请读取选中内容，为镜头准备分镜图。先确认单图还是分镜拼图，复用已有角色和场景素材；生成媒体前展示具体确认。"},
    {id:"image",title:"图片创作",description:"生图与参考图编辑",skills:["image"],goal:"请根据选中内容创作图片或编辑参考图，先确认目标效果，使用真实素材引用并准备节点，生成前由我确认。"},
    {id:"video",title:"视频创作",description:"单镜头或多镜头",skills:["video"],goal:"请读取选中内容和当前视频能力，为视频准备提示词和配置。先确认总时长及独立片段或单次多镜头的安排，复用已有节点，生成前展示具体确认。"},
    {id:"audio",title:"声音创作",description:"配音、歌曲与纯音乐",skills:["audio"],goal:"请根据选中内容创作声音，先确认配音、歌曲还是纯音乐，配音核对角色和音色；准备音频节点，生成前由我确认。"},
    {id:"organize",title:"整理画布",description:"分组、连线与布局",skills:["organize"],goal:"请先读取当前画布和选区，检查来源连线并提出分组与整理方案。只处理本次指定范围，删除和自动排列先展示具体对象供我确认。"},
] as const;
