import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

// Render Markdown returned by the RAG model.
import ReactMarkdown from "react-markdown";

import { askQuestion } from "./services/api";
import type { RagSource } from "./types/rag";

import "./App.css";

/**
 * One message shown in the chat interface.
 */
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: RagSource[];
}

/**
 * Suggested starter questions shown before the
 * user begins a conversation.
 */
const SUGGESTED_QUESTIONS = [
  "What did Zohaib do at PHSA?",
  "Tell me about Roshtay.",
  "What technologies did Zohaib use for JobTrackr?",
  "What did Zohaib contribute to the LLM jailbreak project?",
];

/**
 * Convert internal source IDs into cleaner labels
 * for display in the frontend.
 */
function formatSourceName(
  source: string
): string {
  const labels: Record<string, string> = {
    resume: "Master Resume",
    roshtay: "Roshtay",
    jobtrackr: "JobTrackr",
    "portfolio-website":
      "Portfolio Website",
    "enterprise-llm-jailbreak-detection":
      "LLM Jailbreak Detection",
    "security-log-analyzer":
      "Security Log Analyzer",
  };

  return labels[source] ?? source;
}


function App() {
  // Text currently inside the question input.
  const [question, setQuestion] = useState("");

  // Full conversation shown in the UI.
  const [messages, setMessages] =
    useState<ChatMessage[]>([]);

  // Prevent duplicate requests while one answer
  // is being generated.
  const [loading, setLoading] = useState(false);

  // User-facing API error.
  const [error, setError] = useState("");

  // Invisible element placed at the end of the chat.
  // We scroll to it when the conversation updates.
  const messagesEndRef =
    useRef<HTMLDivElement | null>(null);

  /**
   * Automatically scroll to the newest message
   * whenever messages change or loading begins/ends.
   */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [messages, loading]);

  /**
   * Send a question through the RAG backend.
   */
  async function submitQuestion(
    submittedQuestion: string
  ) {
    const trimmedQuestion =
      submittedQuestion.trim();

    // Ignore empty questions or duplicate requests.
    if (!trimmedQuestion || loading) {
      return;
    }

    // Immediately show the user's message.
    setMessages((current) => [
      ...current,
      {
        role: "user",
        content: trimmedQuestion,
      },
    ]);

    // Clear the input and any previous error.
    setQuestion("");
    setError("");
    setLoading(true);

    try {
      // Call the Express /api/ask endpoint.
      const result =
        await askQuestion(trimmedQuestion);

      // Add the assistant response and its
      // structured source metadata.
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: result.answer,
          sources: result.sources,
        },
      ]);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Unable to answer the question.";

      setError(message);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Handle the normal form submit action.
   */
  async function handleSubmit(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    await submitQuestion(question);
  }

  return (
    <div className="app">
      <header className="hero">
        <span className="eyebrow">
          AI PORTFOLIO ASSISTANT
        </span>

        <h1>
          Ask about Zohaib&apos;s work.
        </h1>

        <p>
          Explore projects, experience, skills,
          and technical contributions through a
          retrieval-augmented portfolio assistant.
        </p>
      </header>

      <main className="chat-container">
        {/* Show starter questions only before
            the conversation begins. */}
        {messages.length === 0 && (
          <section className="welcome">
            <h2>
              What would you like to know?
            </h2>

            <div className="suggestions">
              {SUGGESTED_QUESTIONS.map(
                (suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="suggestion"
                    disabled={loading}
                    onClick={() =>
                      submitQuestion(
                        suggestion
                      )
                    }
                  >
                    {suggestion}
                  </button>
                )
              )}
            </div>
          </section>
        )}

        <section className="messages">
          {messages.map(
            (message, index) => (
              <article
                key={`${message.role}-${index}`}
                className={`message ${message.role}`}
              >
                <div className="message-label">
                  {message.role === "user"
                    ? "You"
                    : "Portfolio Assistant"}
                </div>

                <div className="message-content">
                  {message.role === "assistant" ? (
                    <ReactMarkdown
                      components={{
                        /**
                         * Open portfolio/source links in a new tab
                         * without giving the new page access to the
                         * original browser window.
                         */
                       a: ({
                         children,
                         ...props
                       }) => (
                         <a
                           {...props}
                           target="_blank"
                           rel="noopener noreferrer"
                         >
                           {children}
                         </a>
                       ),
                     }}
                    >
                      {message.content}
                    </ReactMarkdown>
                  ) : (
                    message.content
                  )}
                </div>

                {/* Only assistant messages can
                    contain retrieved sources. */}
                {message.role ===
                  "assistant" &&
                  message.sources &&
                  message.sources.length >
                    0 && (
                    <div className="sources">
                      <span className="sources-title">
                        Sources
                      </span>

                      <div className="source-list">
                        {/*
                          The backend already prunes `sources`
                          down to citations that appear in the
                          sanitized answer text, so we can render
                          them directly without a client-side
                          filter.
                        */}
                        {message.sources.map((source) => (
                            <div
                              key={`${source.citation}-${source.source}-${source.chunkIndex}`}
                              className="source-card"
                            >
                              <span className="citation">
                                {
                                  source.citation
                                }
                              </span>

                              <div className="source-info">
                                <strong>
                                  {formatSourceName(
                                    source.source
                                  )}
                                </strong>

                                <p>
                                  {
                                    source.section
                                  }
                                </p>
                              </div>
                            </div>
                          )
                        )}
                      </div>
                    </div>
                  )}
              </article>
            )
          )}

          {/* Show a lightweight loading state while
              retrieval and generation are running. */}
          {loading && (
            <article className="message assistant">
              <div className="message-label">
                Portfolio Assistant
              </div>

              <div className="thinking">
                <span className="thinking-dot" />
                <span className="thinking-dot" />
                <span className="thinking-dot" />

                <span className="thinking-text">
                  Searching portfolio
                </span>
              </div>
            </article>
          )}

          {/* Invisible scroll target used by useEffect. */}
          <div ref={messagesEndRef} />
        </section>

        {error && (
          <div
            className="error"
            role="alert"
          >
            {error}
          </div>
        )}
      </main>

      <form
        className="question-form"
        onSubmit={handleSubmit}
      >
        <div className="input-wrapper">
          <input
            type="text"
            value={question}
            placeholder="Ask about experience, projects, skills..."
            disabled={loading}
            aria-label="Ask a portfolio question"
            onChange={(event) =>
              setQuestion(
                event.target.value
              )
            }
          />

          <button
            type="submit"
            disabled={
              loading ||
              !question.trim()
            }
          >
            {loading
              ? "Thinking..."
              : "Ask"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default App;