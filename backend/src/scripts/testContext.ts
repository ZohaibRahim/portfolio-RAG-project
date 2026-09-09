import { retrieveContext } from "../services/retrievalService.js";

const question =
  "What did Zohaib contribute to the LLM jailbreak detection project?";

console.log(`Question: ${question}\n`);

const matches = await retrieveContext(question);

console.log(
  `Retrieved ${matches.length} context chunks:\n`
);

for (let i = 0; i < matches.length; i++) {
  const match = matches[i];

  if (!match) {
    continue;
  }

  console.log(`------ CONTEXT ${i + 1} ------`);
  console.log(`Source: ${match.source}`);
  console.log(`Section: ${match.section}`);
  console.log(`Score: ${match.score.toFixed(5)}`);
  console.log();
  console.log(match.content.substring(0, 400));
  console.log();
}