#!/usr/bin/env node
/**
 * Quick test to verify agentic loop setup (ES module version).
 * Full suite: node test-agentic-loop.js
 */
const { AgenticLoop } = await import("./src/core/agentic-loop.js");
const memory = await import("./src/core/memory.js");

if (typeof AgenticLoop !== "function") throw new Error("AgenticLoop class import бүтэлгүйтлээ");
if (typeof memory.createSession !== "function") throw new Error("memory module import бүтэлгүйтлээ");

console.log("✓ agentic-loop.js module found");
console.log("✓ Can import AgenticLoop class");
console.log("✓ Can import memory module");
console.log("\n✅ Setup validation passed!\n");

console.log("Next steps:");
console.log("1. Add ANTHROPIC_API_KEY + TAVILY_API_KEY to .env");
console.log("2. Run the full suite: node test-agentic-loop.js");
console.log("3. Run: node src/search-agent/index.js 'Find React frameworks'");
console.log("4. Monitor iterations in Firebase (optional)\n");
