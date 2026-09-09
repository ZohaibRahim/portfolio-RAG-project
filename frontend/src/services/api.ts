import type { RagAnswer } from "../types/rag";

/**
 * Read the backend URL from Vite's environment variables.
 *
 * During local development:
 * http://localhost:3000
 *
 * Later in production:
 * this will point to the deployed backend.
 */
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL;

/**
 * Send a portfolio question to the Express RAG backend.
 */
export async function askQuestion(
  question: string
): Promise<RagAnswer> {
  const trimmedQuestion = question.trim();

  if (!trimmedQuestion) {
    throw new Error(
      "Question cannot be empty."
    );
  }

  const response = await fetch(
    `${API_BASE_URL}/api/ask`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        question: trimmedQuestion,
      }),
    }
  );

  /**
   * If Express returns something like 400 or 500,
   * try to read its error message before throwing.
   */
  if (!response.ok) {
    const errorData = (await response
      .json()
      .catch(() => null)) as
      | { error?: string }
      | null;

    throw new Error(
      errorData?.error ??
        `Request failed with status ${response.status}`
    );
  }

  return (await response.json()) as RagAnswer;
}