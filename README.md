# MetaStocker 🚀

**MetaStocker** is a premium, local-first AI tool designed for stock photographers and videographers to automate asset attribution. It generates SEO-optimized titles and keywords for stock platforms using advanced AI models.

![MetaStocker Interface](assets/metalogo.png)

## ✨ Key Features

- **Multi-Platform Support**: Tailored metadata for **Adobe Stock**, **Envato Elements**, **Shutterstock**, and **Freepik**.
- **AI-Powered Attribution**: Leverages OpenAI's latest models (GPT-5 series) for high-quality, search-friendly titles and tags.
- **Dynamic Prompts**: Intelligent system prompts that adapt based on the selected AI model (Expert vs. Nano) and specific platform requirements.
- **Background Processing**: Uses **Web Workers** to handle API requests without freezing the UI, allowing you to process large batches while the tab is in the background.
- **Local-First & Private**: Direct API calls from your browser. Your API keys and data never leave your device.
- **Smart Thumbnails**: 
  - Instant downscaling for images.
  - Automatic frame capture for videos (captures a representative frame at 50% duration).
- **Advanced Controls**:
  - **Batch Comments**: Add context for the AI (e.g., "3D icons", "flat design").
  - **Always-Include Tags**: Force specific keywords to appear at the start of your metadata.
  - **Concurrency Control**: Adjust processing speed with 1 to 20 parallel threads.
- **Export Ready**: One-click CSV generation formatted exactly for each stock platform's upload requirements.

## 🛠️ Technology Stack

- **Frontend**: Vanilla JavaScript (ES6+), HTML5, CSS3.
- **Styling**: Tailwind CSS (layout) + Custom CSS Variables (aesthetics).
- **AI**: OpenAI Chat Completions API.
- **Aesthetics**: `tsParticles` for a dynamic background and an "Apple-like" premium glassmorphism design.
- **Utilities**: `exifr` for image metadata extraction (IPTC/XMP).

## 🚀 Getting Started

1. **Open `index.html`** in any modern web browser.
2. **Enter your OpenAI Access Token** (stored locally in your browser).
3. **Select your preferred AI model** (e.g., `gpt-5-nano` for speed/cost or `gpt-5-mini` for quality).
4. **Drag & Drop** your photos or videos into the app.
5. **Click Start** and watch the AI attribute your assets in real-time.
6. **Download your CSVs** and upload them to your contributor dashboards.

## 📁 Project Structure

- `index.html`: The main entry point and UI layout.
- `app.js`: Core logic, API integration, and background worker.
- `style.css`: Custom premium styling and design tokens.
- `blog/`: Articles and guides for stock contributors.
- `Update.bat`: A handy utility for Git operations.

## 📝 License

This project is for personal and commercial use in stock asset management. All processing is done client-side.

---
*Created with ❤️ for the Stock Contributor Community.*