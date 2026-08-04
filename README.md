# 相机媒体提取工具

一个通用的相机媒体提取脚本：遍历相机媒体目录，保持目录结构把媒体文件处理到目标目录中。照片原样拷贝，视频压缩转码（默认转码为 H.265）。

> 本项目由 **DeepSeek AI** 编写。

## 功能特性

- 遍历相机媒体目录，保持目录结构
- 照片（jpg/png/raw 等）原样拷贝
- 视频压缩转码（默认 H.265，可选 H.264）
- 设置转码后文件的创建/修改时间与源文件一致
- 处理完成的文件移动到源目录下的「已处理」目录
- 非媒体文件留在原地，删除空子目录
- 支持并发转码
- 支持处理过滤器（glob 通配符匹配文件名/目录名）

## 环境要求

- Node.js（建议 18+）
- ffmpeg / ffprobe（在 PATH 中，或通过环境变量指定路径）

## 快速开始

1. 复制一份 `run_sample.bat` 并重命名为你想要的启动脚本名称
2. 在启动脚本中设置必要的环境变量
3. 双击运行启动脚本

## 环境变量说明

| 环境变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `CAMERA_MEDIA_DIR` | ✅ | 无 | 相机媒体源目录 |
| `TARGET_DIR` | ✅ | 无 | 目标目录 |
| `TARGET_VIDEO_CODEC` | 否 | `h265` | 目标视频编码：`h265` 或 `h264` |
| `VIDEO_TRANSCODE_CONCURRENCY` | 否 | `1` | 视频并发转码任务数 |
| `FFMPEG_PATH` | 否 | `ffmpeg` | ffmpeg 可执行文件路径（默认走 PATH） |
| `FFPROBE_PATH` | 否 | `ffprobe` | ffprobe 可执行文件路径（默认走 PATH） |
| `PROCESS_FILTER` | 否 | 空 | 只处理匹配的文件/目录，多个用逗号分隔（glob 模式，见下方说明） |
| `FORCE_TRANSCODE` | 否 | 关 | 设为 `1` 或 `true` 时强制转码所有视频（测试用） |

> 注意：`CAMERA_MEDIA_DIR` 和 `TARGET_DIR` 为必填项，未设置时程序会报错并退出。

## 示例

启动脚本示例（实际使用配置）：

```bat
@echo off
chcp 65001 >nul
cd /d "%~dp0"

set CAMERA_MEDIA_DIR=F:\DCIM
set TARGET_DIR=G:\照片
set TARGET_VIDEO_CODEC=h265
set VIDEO_TRANSCODE_CONCURRENCY=2

node index.js
pause
```

### PROCESS_FILTER 通配符说明

`PROCESS_FILTER` 使用 glob 模式匹配文件/目录的相对路径（用 `/` 分隔），支持以下通配符：

| 通配符 | 说明 | 示例 |
| --- | --- | --- |
| `*` | 匹配单个路径段内的任意字符（不含 `/`） | `img_*.jpg` 匹配 `img_1.jpg`、`img_abc.jpg` |
| `**` | 匹配多级未知目录（含 `/`） | `**/video_*` 匹配任意目录下的 `video_*` 文件/目录 |

示例：

```bat
rem 只处理 img_ 开头的 jpg 图片
set PROCESS_FILTER=img_*.jpg

rem 处理任意目录下 video_ 开头的文件/目录
set PROCESS_FILTER=**/video_*

rem 只处理指定目录
set PROCESS_FILTER=100MSDCF,101MSDCF
```

> 不匹配过滤器的文件会被标记为「忽略:规则跳过」，不会处理。

## 开发

```bash
# 安装依赖
npm install

# 构建（生成根目录 index.js）
npm run build

# 运行
#使用启动脚本运行
```
