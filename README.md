# MetaStocker 🚀

**MetaStocker** is a browser-first AI tool for stock photographers and videographers that automates asset attribution. It generates SEO-optimized titles and keywords for stock platforms using advanced AI models.

![MetaStocker Interface](assets/metalogo.png)

## ✨ Key Features

- **Multi-Platform Support**: Tailored metadata for **Adobe Stock**, **Envato Elements**, **Shutterstock**, and **Freepik**.
- **AI-Powered Attribution**: Leverages OpenAI's latest models (GPT-5 series) for high-quality, search-friendly titles and tags.
- **Dynamic Prompts**: Intelligent system prompts that adapt based on the selected AI model (Expert vs. Nano) and specific platform requirements.
- **Background Processing**: Uses **Web Workers** to handle API requests without freezing the UI, allowing you to process large batches while the tab is in the background.
- **Browser-first**: Original files stay in your browser. Selected previews, metadata, and your API key are sent directly to your chosen AI provider; MetaStocker has no storage backend.
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
- **Styling**: Static Tailwind CSS 3.4.17 utilities (layout) + custom CSS variables (aesthetics).
- **AI**: OpenAI Chat Completions API.
- **Aesthetics**: `tsParticles` for a dynamic background and an "Apple-like" premium glassmorphism design.
- **Utilities**: `exifr` for image metadata extraction (IPTC/XMP).

## 🚀 Getting Started

1. **Open `index.html`** in any modern web browser.
2. **Enter your OpenAI API key** (kept in session storage for the current browser tab).
   New to the OpenAI API? Follow the [illustrated API key setup guide](blog/how-to-get-openai-api-key.html).
3. **Select your preferred AI model** (e.g., `gpt-5-nano` for speed/cost or `gpt-5-mini` for quality).
4. **Drag & Drop** your photos or videos into the app.
5. **Click Start** and watch the AI attribute your assets in real-time.
6. **Download your CSVs** and upload them to your contributor dashboards.

### Rebuilding styles

After adding or changing Tailwind utility classes in HTML or `app.js`, rebuild the checked-in production stylesheet:

```sh
npx --yes tailwindcss@3.4.17 -i tailwind.input.css -o tailwind.generated.css --content './index.html,./blog/**/*.html,./app.js' --minify
```

## 📁 Project Structure

- `index.html`: The main entry point and UI layout.
- `app.js`: Core logic, API integration, and background worker.
- `style.css`: Custom premium styling and design tokens.
- `tailwind.input.css`: Tailwind build entry point.
- `tailwind.generated.css`: Minified static Tailwind utility bundle used in production.
- `blog/`: Articles and guides for stock contributors.
- `Update.bat`: A handy utility for Git operations.

## 📝 License

This project is for personal and commercial use in stock asset management. All processing is done client-side.

---
*Created with ❤️ for the Stock Contributor Community.*
