# 🚀 Nebulux Multi-Agent System: Interview Preparation Guide

This document is designed to help you explain your Multi-Layer Agent project during technical interviews. It breaks down the technologies used, why you chose them, and key architectural concepts you should highlight.

---

## 1. Project Elevator Pitch
*"I built an autonomous multi-agent orchestration system called Nebulux. It acts as an AI software factory. You give it a project description, and it orchestrates a pipeline of specialized AI agents—a Supervisor, Planner, Designer, Coder, and DevOps agent. These agents collaborate, write code, validate each other's work, and output a complete full-stack application, while streaming their live progress to a frontend dashboard."*

---

## 2. Technologies Used & How You Used Them

### 💻 Frontend (Client-Side)
*   **Vanilla JavaScript, HTML5, CSS3**: 
    *   **How:** Built the UI from scratch without heavy frameworks (like React) to keep it lightweight, fast, and demonstrate strong foundational DOM manipulation skills.
*   **WebSocket API (Native)**: 
    *   **How:** Crucial for the user experience. Because AI generation takes minutes, standard HTTP requests would timeout or require inefficient "polling". WebSockets allow the server to push real-time logs, progress bars, and state changes to the UI instantly.
*   **HTML5 Canvas API**: 
    *   **How:** Used to create the dynamic, animated star background. Shows attention to detail and UI/UX polish.

### ⚙️ Backend (Server-Side)
*   **Node.js & Express.js**: 
    *   **How:** Used as the core server framework. Express handles the HTTP routes (like the API health checks and starting the pipeline) and serves the application.
*   **`ws` (WebSocket Library)**: 
    *   **How:** Integrated with the Express server to handle the persistent, bidirectional communication required for the live agent activity feed.
*   **LLM SDKs (`@anthropic-ai/sdk`, `@google/genai`)**: 
    *   **How:** Integrated official SDKs to securely and efficiently communicate with cloud AI providers (Claude and Gemini).
*   **Axios**: 
    *   **How:** Used for making custom RESTful HTTP requests for APIs that didn't use an SDK (like Kimi NIM and your local Ollama instance).
*   **Dotenv**: 
    *   **How:** Implemented to keep sensitive API keys securely out of the source code.

### 🧠 AI & Machine Learning Models (The Agents)
*   **Anthropic Claude**: Used as the "Brains" (Supervisor, Planner, DevOps) due to its strong complex reasoning and code-review capabilities.
*   **Google Gemini & Kimi**: Used as the "Designer" for creative UI/UX generation.
*   **Ollama (Gemma)**: Used for local backend code generation. **Highlight this!** Interviewers love seeing developers who know how to run open-source models locally to save costs and ensure privacy.

---

## 3. Key Architectural Concepts to Highlight (Talking Points)

If an interviewer asks, *"What was the most challenging or interesting part of this project?"*, use these:

1.  **Separation of Concerns (Multi-Agent Pattern)**
    *   *What to say:* "Instead of using one massive prompt to build an app, I engineered a pipeline. The **Planner** designs the architecture, the **Designer** makes the UI, the **Coder** writes the backend, and the **Supervisor** oversees the handoffs. This modularity means I can swap out a model (like switching the Coder from Claude to local Gemma) without breaking the system."
2.  **Asynchronous Orchestration & WebSockets**
    *   *What to say:* "Managing long-running LLM tasks is tough. Standard HTTP times out. I architected a WebSocket solution so the backend can continuously stream status updates (`agent_status`, `progress`, `log`) to the frontend, keeping the user engaged while the AI thinks."
3.  **Hybrid Cloud/Local AI Architecture**
    *   *What to say:* "The system is agnostic to where the AI runs. It can route complex reasoning tasks to premium cloud models (Claude) via SDKs, while routing code-generation tasks to a local Ollama instance via standard REST APIs, optimizing for both performance and cost."
4.  **Error Handling & Fallbacks**
    *   *What to say:* "AI APIs fail often due to rate limits. I built health-check endpoints and error handling into the WebSocket stream so if an agent hits a 429 Rate Limit, it fails gracefully and alerts the UI rather than crashing the server."
