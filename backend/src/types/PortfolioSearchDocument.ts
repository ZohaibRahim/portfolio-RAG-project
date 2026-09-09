import { PortfolioChunk } from "./PortfolioChunk.js";

export interface PortfolioSearchDocument
  extends PortfolioChunk {
  contentVector: number[];
}