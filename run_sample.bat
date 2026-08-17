@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  相机媒体提取工具 - 示例配置脚本
rem  本文件为示例，展示所有可设置的环境变量及用法。
rem  复制本文件并重命名为你想要的启动脚本名称后按需修改即可使用。
rem ============================================================

rem 相机媒体源目录（必填，无默认值）
set CAMERA_MEDIA_DIR=F:\DCIM

rem 目标目录（必填，无默认值）
set TARGET_DIR=G:\照片

rem 已处理目录（默认 "已处理"，非绝对路径则相对源目录）
rem set PROCESSED_DIR=已处理

rem 目标视频编码：h265 或 h264（默认 h265）
set TARGET_VIDEO_CODEC=h265

rem 视频并发转码任务数（默认 1）
set VIDEO_TRANSCODE_CONCURRENCY=1

rem ffmpeg 可执行文件路径（默认 "ffmpeg"；若不在 PATH 中可指定具体路径）
rem set FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe

rem ffprobe 可执行文件路径（默认 "ffprobe"；若不在 PATH 中可指定具体路径）
rem set FFPROBE_PATH=C:\ffmpeg\bin\ffprobe.exe

rem 强行转码所有视频（测试用）：1 或 true 开启
rem set FORCE_TRANSCODE=1

rem 处理过滤器：只处理匹配的文件/目录，多个用逗号分隔（glob 模式）
rem   *  匹配单个路径段内的任意字符（不含 /）
rem   ** 匹配多级未知目录（含 /）
rem 不设置则处理所有文件。示例：
rem   set PROCESS_FILTER=img_*.jpg
rem   set PROCESS_FILTER=**/video_*
rem   set PROCESS_FILTER=100MSDCF,101MSDCF

node index.js
pause
