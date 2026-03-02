# MetaStocker Project Specification

## 1. Project Overview
**Name**: MetaStocker
**Type**: Single Page Application (SPA) / Local-First Tool
**Purpose**: AI-powered metadata generator for stock footage and images. It automates the creation of Titles, Descriptions, Keywords, and Categories for Adobe Stock, Envato Elements, and Shutterstock.

## 2. Technology Stack
- **Core**: HTML5, Vanilla JavaScript (ES6+), CSS3.
- **Architecture**: Single File Component (all logic, styles, and markup in one `index.html`).
- **Styling**: 
  - **Tailwind CSS** (via CDN) for layout.
  - **Custom CSS Variables** for theming (Apple/iOS style aesthetics: nice blurs, shadows, transitions).
- **Libraries**:
  - `tsparticles` (via CDN) for background effects.
- **Backend**: None (Serverless/Client-side only).
- **AI Provider**: OpenAI API (direct client-side calls).

## 3. Key Design Features
- **Visual Style**: Premium "Apple-like" design. Light/Dark mode support (hardcoded to Light mostly in CSS variables).
- **Components**:
  - **Glassmorphism Topbar**: Sticky header with blur effect.
  - **Interactive Particle Background**: Subtle animated dots/lines.
  - **Drag & Drop Zone**: Large, animated area for file import.
  - **Data Table**: Resizable columns, sticky headers, inline status updates.
  - **Floating Action Buttons**: For logs and main controls.
  - **Nyan Cat Progress Bar**: Custom progress visualization (though named Nyan, style is minimalist).

## 4. Core Functionalities

### A. File Import & Management
- **Drag & Drop**: Supports multiple files.
- **File Types**: Images (JPG, PNG, SVG) and Videos (MP4, WEBM, MOV, etc.).
- **Duplicate Prevention**: Filters out files with names that already exist in the list.
- **Thumbnail Generation**:
  - Images: Downscaled on client-side.
  - Videos: Captures a frame from the middle of the video using a hidden `<video>` element.

### B. AI Processing (The "Brain")
- **Web Worker Implementation**: API calls run in a dedicated Web Worker to prevent UI freezing and allow background tab processing.
- **Keep-Alive Mechanism**: 500ms heartbeat interval to prevent browser throttling when the tab is inactive.
- **Concurrency Control**: User-adjustable slider (1-20 threads).
- **API Integration**:
  - Direct calls to OpenAI Chat Completions API.
  - Supports `gpt-4o` (referenced as gpt-5-nano in UI) and other models.
  - Uses `json_schema` response format for structured data.

### C. Workflow Logic
1.  **Queue System**: Files have statuses: `queued`, `processing`, `done`, `error`.
2.  **Smart Skipping**: If "Start" is clicked again, it skips files marked as `done` and only processes `queued` ones.
3.  **Prompt Engineering**:
    - **Base Prompt**: Generates Adobe Stock compatible Title (150-180 chars) and 40-49 Keywords.
    - **Envato Prompt**: Rewrites title to be <90 chars.
    - **Shutterstock Prompt**: Selects specific categories from a predefined list.

### D. Data Export
- **CSV Generation**: Client-side generation of CSV files.
- **Formats**:
  - **Adobe Stock**: Filename, Title, Keywords, Category.
  - **Envato Elements**: Specific columns for price, codec, resolution, etc.
  - **Shutterstock**: Description, Keywords, Categories.
- **Persistence**: `localStorage` saves API key and column widths.

### E. Logs & Debugging
- **System Logs**: In-app console showing success/error messages, API retries, network status.
- **Export**: Copy to clipboard or download logs as .txt.

## 5. Specific Implementation Details (Critical for Recreation)

### 1. Web Worker Code (Inline)
The app uses an inline Blob-based Web Worker to handle `fetch` requests. This is crucial for performance and background processing.
```javascript
const workerCode = `self.onmessage = async (e) => { ... fetch logic ... }`;
const blob = new Blob([workerCode], {type: 'application/javascript'});
```

### 2. Video Thumbnail Logic
It waits for the video `loadedmetadata`, seeks to 50% duration (`duration * 0.5`), draws to canvas, and exports as JPEG dataURL.

### 3. OpenAI Schema
Enforces strictly structured JSON output:
```json
{
  "name": "stock_fields",
  "schema": {
    "type": "object",
    "properties": {
      "title": { "type": "string" },
      "tags": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["title", "tags"],
    "additionalProperties": false,
    "strict": true
  }
}
```

### 4. Retry Logic
Custom retry wrapper around API calls:
- 3 Attempts total.
- Exponential backoff (delay * attempt).
- Handled errors: 429 (Rate Limit), 5xx (Server), JSON parse errors.

## 6. Directory Structure (Conceptual)
Since it's a single file, the structure is virtual:
- `index.html`
  - `<head>`: Styles (Tailwind CDN, CSS vars).
  - `<body>`: UI Markup.
  - `<script>`:
    - Utils (sleep, tick).
    - Web Worker Init.
    - Spec/Config maps (Envato Defaults, Prompt Templates).
    - UI Handlers (Drag&Drop, Modals).
    - Core Logic (Process Loop, API Calls).

## 7. Known Quirks / User Preferences
- **Defaults**: Concurrency defaults to 3 but allows up to 20.
- **Model Names**: UI uses custom names like `gpt-5-nano` which map to specific model IDs internally (or pass through if valid).
- **Environment**: Designed to run locally (file:// protocol) or hosted statically.
