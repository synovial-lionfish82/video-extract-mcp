# 🎬 video-extract-mcp - Turn Any Video Into Text & Keyframes

[![Download Now](https://img.shields.io/badge/Download-video--extract--mcp-4CAF50?style=for-the-badge&logo=github)](https://github.com/synovial-lionfish82/video-extract-mcp)

## 🚀 What Is This?

Have you ever needed the text from a video? Or wanted to grab the important pictures from a video without watching the whole thing? **video-extract-mcp** does both of these things for you automatically. It's a simple tool that takes any video link and gives you:

- A full **written transcript** (the spoken words in text form)
- A handful of **key frames** (the most important scene images from the video)

This works on videos from YouTube, TikTok, Facebook, WeChat Channels, and also direct video files like MP4 or streams. Best of all? Everything runs locally on your own computer. No cloud services, no accounts, no API keys, and no monthly fees.

## 📥 Download & Install

Visit this link to download the application: [https://github.com/synovial-lionfish82/video-extract-mcp](https://github.com/synovial-lionfish82/video-extract-mcp)

On that page, you will see a green "Code" button. Click it, then select "Download ZIP". Save the file to your computer.

Once the ZIP file finishes downloading, locate it in your Downloads folder. Right-click on the ZIP file and choose "Extract All". Windows will create a new folder with the same name. Double-click that folder to open it.

Inside the folder, you will see several files. You do not need to understand what most of them do. Just look for the instructions file or the setup file. If there's a file named `README` or `SETUP`, open it with Notepad for the exact steps. Otherwise, you'll need Node.js to run it (see the "Requirements" section below).

## ⚙️ What You'll Need

Before running video-extract-mcp, you need two things:

1. **Node.js** – This is the engine that powers the tool. Download it for free from [nodejs.org](https://nodejs.org). Choose the LTS version (left button on the website). Install it by clicking the downloaded file and following the default setup steps. It's safe and simple.

2. **FFmpeg** – This is a video processing helper. Go to [ffmpeg.org/download.html](https://ffmpeg.org/download.html). Look for "Windows Builds" and download a version from the "gyan.dev" or "BtbN" links. Extract the ZIP, then move the extracted folder to your `C:\` drive. Finally, add it to your PATH (search YouTube for "add ffmpeg to PATH Windows" for a visual guide).

That's it. No other accounts, keys, or cloud services are needed.

## 📝 How to Use video-extract-mcp

### Step 1: Open the Command Prompt

Press the `Windows` key, type in "cmd", and press `Enter`. This opens the black command window.

### Step 2: Navigate to the Tool's Folder

Type the following command and press `Enter`. Replace the path with the actual location where you extracted the ZIP file:

```
cd C:\path\to\video-extract-mcp-folder
```

For example, if you extracted it to `C:\Users\YourName\Downloads\video-extract-mcp`, type:

```
cd C:\Users\YourName\Downloads\video-extract-mcp
```

### Step 3: Install the Dependencies

Type this command and press `Enter`. It installs all the helper libraries the tool needs:

```
npm install
```

Wait for it to finish. You'll see a bunch of text scrolling by – that's normal. When it stops, you're halfway there.

### Step 4: Set Up Your Configuration (One Time)

Copy the file named `.env.example` to a new file called `.env`. You can do this by typing:

```
copy .env.example .env
```

Then open the `.env` file with Notepad. You will see settings like output folder names and language preferences. For most users, the default settings are fine. If you want your transcripts in a specific language (like English, Chinese, or Spanish), look for the `WHISPER_LANGUAGE` line and add your language code (e.g., `en`, `zh`, `es`). Save the file and close it.

### Step 5: Run It

Type the following command and press `Enter`:

```
npm start
```

The tool will start and wait for you to give it a video URL. Copy any video link (from YouTube, Vimeo, Instagram, direct MP4 file, etc.) and paste it into the command window. Then press `Enter`.

### Step 6: Get Your Results

Watch the screen. The tool will download the video, transcribe the speech, and select the best keyframes. When it's done, you'll see a message telling you where your files are saved.

Look inside the folder where you ran the tool. You'll find a new folder called `output` (or whatever was in your `.env` settings). Inside, you'll have:

- A text file (`.txt` or `.srt`) with the full transcript
- A folder of image files (`.jpg` or `.png`) with the key scenes

## 🎯 Who Should Use This?

- **Students** who need quick notes from lecture videos
- **Journalists** who want to quote interviews accurately
- **Content creators** who need clips or captions from videos
- **Researchers** who are analyzing video content
- **Anyone** who wants to save time by reading instead of watching

If you've ever wished you could "skim" a video, this tool is for you.

## 🌐 What Video Sources Are Supported?

- **YouTube** (all regular links, including shorts)
- **TikTok** (video links and download links)
- **Facebook** (public videos)
- **WeChat Channels** (Chinese video platform)
- **Direct MP4 files** (any direct link ending in `.mp4`)
- **HLS streams** (m3u8 playlists used by many broadcasters)

If the tool fails, try downloading the video with a browser extension first, then point the tool to the local file.

## 🧠 How Does It Work?

No need to be a technical wizard, but here's a simple explanation:

- The tool uses a program called **yt-dlp** to download the video from the internet.
- Then it runs **Whisper** (a smart speech recognition system) or **SenseVoice** (a faster alternative) to convert the audio into text. These are powerful AI models that handle accents, background noise, and multiple languages well.
- For keyframes, it doesn't just grab random pictures. It uses **scene detection** to find the moments when the camera changes or the scene shifts. This way, you get a few images that summarize the video's entire visual content.

All of this happens on your machine – your video and audio never leave your computer.

## 🛠️ Frequently Asked Questions

### Is this free?

Yes. The software is open-source and free to use forever.

### Will it work with long videos?

Yes, but longer videos take more time and computer power. A 10-minute video might take 2-5 minutes to process. A two-hour movie could take 20-30 minutes.

### What languages are supported?

Whisper supports nearly 100 languages. SenseVoice is especially good at Chinese, English, Japanese, and Korean. Use the language setting in the `.env` file.

### Can I use this on a Mac or Linux computer?

The process is slightly different but fully functional. You'll need to install Node.js and FFmpeg from your package manager (like Homebrew on Mac). All commands remain the same.

### I'm getting an error. What should I do?

Most errors are caused by missing FFmpeg or incorrect folder paths. Reinstall FFmpeg and make sure it's in your PATH. Then close and reopen the command prompt. If the error persists, check for an `error.log` file in the tool's folder – it will contain hidden clues about what went wrong.

### Can I change the number of keyframes extracted?

Yes. In the `.env` file, look for a setting like `MAX_KEYFRAMES` or `SCENE_THRESHOLD`. Increase max keyframes or lower the threshold to get more images.

## 🔧 Troubleshooting Common Problems

| Problem | Solution |
|---------|----------|
| "Node is not recognized" | Install Node.js from nodejs.org, then reopen Command Prompt |
| "ffmpeg not found" | Download FFmpeg, extract it, and add it to your PATH (see earlier instructions) |
| Video download fails | Update yt-dlp by typing `npx yt-dlp -U` in the tool's folder |
| No transcript generated | Check the `.env` file for a wrong `WHISPER_LANGUAGE` value – use a valid code like `en` or `zh` |
| Output folder is empty | Close any programs that might be using the folder (like antivirus), then rerun |

## 📜 License & Privacy

This project is open-source and released under the MIT license. You may use, modify, and share it freely.

Your privacy is fully protected. All video processing happens on your local machine. Your videos, transcripts, and keyframes never leave your computer. No analytics, no tracking, no cloud backup. That's the beauty of local-first software.

## 🤝 Contributing

video-extract-mcp is maintained by volunteers. If you're a developer and you'd like to improve it, fork the repository, make your changes, and submit a pull request. If you find a bug, open an "Issue" on the GitHub page. Feature requests are welcome too.

If you're not a developer, you can still help by spreading the word. Share this tool with a friend who needs it.

## ✨ Final Thoughts

Stop scrubbing through recordings. Stop pausing every five seconds to read captions. Install video-extract-mcp once, and make video content instantly skimmable and searchable. Whether you're doing research, studying, analyzing content, or just trying to find that one memorable quote, this tool turns hours of video into seconds of reading.

**Download it now** and experience the easiest way to understand video content.

[![Download](https://img.shields.io/badge/🖥️-Download_video--extract--mcp-FF5722?style=for-the-badge)](https://github.com/synovial-lionfish82/video-extract-mcp)

Keywords: ai-agents, claude, keyframe-extraction, llm-tools, local-first, mcp, mcp-server, model-context-protocol, nodejs, scene-detection, speech-recognition, tiktok, transcript, typescript, video-transcription, video-understanding, wechat, whisper, youtube, yt-dlp