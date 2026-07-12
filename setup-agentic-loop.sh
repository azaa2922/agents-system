#!/bin/bash

# Agentic Loop Auto Setup Script
# Run with: ./setup-agentic-loop.sh
# Or in Claude Code: claude setup-agentic-loop.sh

set -e  # Exit on error

echo "🚀 Starting Agentic Loop Auto Setup..."
echo "=========================================="

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if we're in the right directory
if [ ! -f "package.json" ] || [ ! -d "src" ]; then
  echo -e "${RED}❌ Error: Must run from agents-system root directory${NC}"
  exit 1
fi

# Step 1: Copy agentic-loop.js
echo -e "${BLUE}Step 1: Copying agentic-loop.js to src/core/${NC}"
mkdir -p src/core
cat > src/core/agentic-loop.js << 'EOF'
/**
 * src/core/agentic-loop.js
 * 
 * Core autonomy engine. Implements the plan-execute-reflect loop.
 * Agent autonomously loops until goal is complete, no human intervention needed.
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");

class AgenticLoop {
  constructor(sessionId, memory, geminiApiKey, toolRegistry) {
    this.sessionId = sessionId;
    this.memory = memory;
    this.gemini = new GoogleGenerativeAI(geminiApiKey);
    this.tools = toolRegistry;
    this.iterationCount = 0;
    this.maxIterations = 50;
  }

  async run(goal, maxIterations = 50) {
    this.maxIterations = maxIterations;
    console.log(`\n🎯 Starting agentic loop for goal: "${goal}"\n`);

    try {
      const context = await this.memory.getContext(this.sessionId);
      let isComplete = false;
      let completionReason = "";

      while (this.iterationCount < this.maxIterations && !isComplete) {
        console.log(
          `\n━━━ ITERATION ${this.iterationCount + 1} ━━━━━━━━━━━━━━━━━━━━━━━━━━`
        );

        try {
          // PHASE 1: PLAN
          const planResult = await this._plan(goal, context);
          if (!planResult.steps || planResult.steps.length === 0) {
            isComplete = true;
            completionReason = planResult.reasoning;
            break;
          }

          await this.memory.addSteps(this.sessionId, planResult.steps);
          console.log(`📋 Planned ${planResult.steps.length} steps`);
          planResult.steps.forEach((step, idx) => {
            console.log(`  ${idx + 1}. [${step.action}] ${step.description}`);
          });

          // PHASE 2: EXECUTE
          const executionResults = await this._executeSteps(planResult.steps);
          console.log(`\n✅ Executed ${executionResults.length} steps`);

          // PHASE 3: REFLECT
          const reflection = await this._reflect(
            goal,
            planResult,
            executionResults,
            context
          );

          await this.memory.updateContext(this.sessionId, {
            accumulated_knowledge: reflection.updatedKnowledge,
            last_reflection: reflection.analysis,
            steps_executed: this.iterationCount + 1,
          });

          if (reflection.isGoalComplete) {
            isComplete = true;
            completionReason = reflection.completionReason;
            console.log(`\n🎉 Goal complete: ${completionReason}`);
          } else {
            console.log(`\n🔄 Not yet complete. ${reflection.nextAction}`);
          }

          this.iterationCount++;
        } catch (stepError) {
          console.error(
            `❌ Error during iteration ${this.iterationCount + 1}:`,
            stepError.message
          );
          await this.memory.updateContext(this.sessionId, {
            last_error: stepError.message,
            error_iteration: this.iterationCount + 1,
          });
          this.iterationCount++;
        }
      }

      if (isComplete) {
        await this.memory.completeSession(this.sessionId, {
          success: true,
          completionReason,
          iterations: this.iterationCount,
        });
      } else if (this.iterationCount >= this.maxIterations) {
        console.log(
          `\n⚠️  Max iterations (${this.maxIterations}) reached.`
        );
        await this.memory.completeSession(this.sessionId, {
          success: false,
          reason: "Max iterations reached",
          iterations: this.iterationCount,
        });
      }

      return {
        success: isComplete,
        result: completionReason,
        iterations: this.iterationCount,
      };
    } catch (error) {
      console.error("Fatal error in agentic loop:", error);
      await this.memory.completeSession(this.sessionId, {
        success: false,
        error: error.message,
        iterations: this.iterationCount,
      });
      throw error;
    }
  }

  async _plan(goal, context) {
    const model = this.gemini.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `You are an autonomous AI agent. Your goal is: "${goal}"

Current context:
${context?.accumulated_knowledge || "(none yet)"}

Plan the NEXT 2-3 concrete steps. If goal is complete, respond with empty steps array.

Respond ONLY in JSON format (no markdown, no code blocks):
{
  "reasoning": "why planning these steps",
  "steps": [
    {
      "action": "search|code|data|file|write|db|think",
      "description": "what to do",
      "params": { "key": "value" }
    }
  ]
}`;

    try {
      const response = await model.generateContent(prompt);
      const text = response.response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found");

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        reasoning: parsed.reasoning,
        steps: parsed.steps || [],
      };
    } catch (error) {
      console.error("Planning error:", error.message);
      return { reasoning: "Planning failed", steps: [] };
    }
  }

  async _executeSteps(steps) {
    const results = [];
    for (const step of steps) {
      try {
        console.log(`\n  → Executing: [${step.action}] ${step.description}`);
        const stepStartTime = Date.now();
        const result = await this._executeAction(step.action, step.params || {});
        const duration = ((Date.now() - stepStartTime) / 1000).toFixed(2);

        results.push({
          action: step.action,
          description: step.description,
          success: true,
          result,
          duration: `${duration}s`,
        });
        console.log(`    ✓ Success (${duration}s)`);
      } catch (error) {
        results.push({
          action: step.action,
          description: step.description,
          success: false,
          error: error.message,
        });
        console.log(`    ✗ Failed: ${error.message}`);
      }
    }
    return results;
  }

  async _executeAction(action, params) {
    if (!this.tools[action]) {
      throw new Error(`Unknown action: ${action}`);
    }
    return await this.tools[action](params);
  }

  async _reflect(goal, planResult, executionResults, context) {
    const model = this.gemini.getGenerativeModel({ model: "gemini-1.5-flash" });

    const executionSummary = executionResults
      .map(
        (r) =>
          `[${r.action}] ${r.description}: ${
            r.success ? `✓ ${r.result?.substring(0, 100) || "done"}` : `✗ ${r.error}`
          }`
      )
      .join("\n");

    const prompt = `Reflect on progress toward: "${goal}"

Execution results:
${executionSummary}

Current knowledge:
${context?.accumulated_knowledge || "(none)"}

Analyze: Did we move toward the goal? Is it COMPLETE?

Respond ONLY in JSON (no markdown):
{
  "analysis": "brief analysis",
  "isGoalComplete": true/false,
  "completionReason": "why complete or not",
  "nextAction": "what to do next",
  "updatedKnowledge": "new insights"
}`;

    try {
      const response = await model.generateContent(prompt);
      const text = response.response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON in response");

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        analysis: parsed.analysis,
        isGoalComplete: parsed.isGoalComplete || false,
        completionReason: parsed.completionReason || "Unable to determine",
        nextAction: parsed.nextAction || "Continue",
        updatedKnowledge: parsed.updatedKnowledge || "",
      };
    } catch (error) {
      console.error("Reflection error:", error.message);
      return {
        analysis: "Reflection failed",
        isGoalComplete: false,
        completionReason: "Reflection error",
        nextAction: "Retry",
        updatedKnowledge: "",
      };
    }
  }
}

module.exports = AgenticLoop;
EOF
echo -e "${GREEN}✓ agentic-loop.js created${NC}"

# Step 2: Update search agent
echo -e "${BLUE}Step 2: Updating search-agent/index.js${NC}"
cat > src/search-agent/index.js << 'EOF'
/**
 * Search Agent with Agentic Loop
 * Autonomously searches, analyzes, and reports
 */

const AgenticLoop = require("../core/agentic-loop");
const memory = require("../core/memory");
const axios = require("axios");

const toolRegistry = {
  async search(params) {
    const { query } = params;
    console.log(`    [Tavily] Searching: "${query}"`);
    
    try {
      const response = await axios.get("https://api.tavily.com/search", {
        params: {
          api_key: process.env.TAVILY_API_KEY,
          query: query,
          max_results: 10,
          include_answer: true,
        },
      });
      
      return JSON.stringify({
        query,
        count: response.data.results.length,
        answer: response.data.answer?.substring(0, 200),
      });
    } catch (error) {
      throw new Error(`Search failed: ${error.message}`);
    }
  },

  async write(params) {
    const { topic, content } = params;
    console.log(`    [Writer] Writing about "${topic}"`);
    return `Created content about ${topic}`;
  },

  async think(params) {
    return "Reflection complete";
  },
};

async function main() {
  const goal = process.argv[2] || "Find React frameworks and compare them";

  try {
    console.log(`\n📊 Search Agent Starting`);
    console.log(`Goal: ${goal}\n`);

    await memory.initFirebase();
    const sessionId = await memory.createSession(goal, "search-agent");

    const loop = new AgenticLoop(
      sessionId,
      memory,
      process.env.GEMINI_API_KEY,
      toolRegistry
    );

    const result = await loop.run(goal, 20);

    console.log("\n" + "=".repeat(60));
    console.log("SEARCH AGENT COMPLETE");
    console.log("=".repeat(60));
    console.log(`Success: ${result.success}`);
    console.log(`Iterations: ${result.iterations}`);
    console.log(`Result: ${result.result}`);
    
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

main();
EOF
echo -e "${GREEN}✓ search-agent/index.js updated${NC}"

# Step 3: Create tool registry template for other agents
echo -e "${BLUE}Step 3: Creating tool registry templates${NC}"

# Code agent
cat > src/code-agent/tool-registry.js << 'EOF'
/**
 * Code Agent Tool Registry
 * Maps actions to implementations
 */

const fs = require("fs");
const path = require("path");

module.exports = {
  async code(params) {
    const { description } = params;
    console.log(`    [CodeGen] Generating: ${description}`);
    return `Generated code for: ${description}`;
  },

  async file(params) {
    const { operation, file, content } = params;
    console.log(`    [FileOps] ${operation} on ${file}`);
    
    if (operation === "create" && content) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    return `File operation done: ${file}`;
  },

  async write(params) {
    const { type, content } = params;
    console.log(`    [Writer] Creating ${type}`);
    return `Created ${type}`;
  },

  async think(params) {
    return "Reflection complete";
  },
};
EOF
echo -e "${GREEN}✓ code-agent/tool-registry.js created${NC}"

# Data agent
cat > src/data-agent/tool-registry.js << 'EOF'
/**
 * Data Agent Tool Registry
 */

module.exports = {
  async data(params) {
    const { file, analysis } = params;
    console.log(`    [DataAnalysis] ${analysis} on ${file}`);
    return `Analysis: ${analysis}`;
  },

  async file(params) {
    const { operation, file } = params;
    console.log(`    [FileOps] ${operation} on ${file}`);
    return `File operation: ${operation}`;
  },

  async write(params) {
    const { type } = params;
    console.log(`    [Writer] Creating ${type}`);
    return `Created ${type}`;
  },

  async think(params) {
    return "Reflection complete";
  },
};
EOF
echo -e "${GREEN}✓ data-agent/tool-registry.js created${NC}"

# Step 4: Create test file
echo -e "${BLUE}Step 4: Creating test file${NC}"
cat > test-agentic-setup.js << 'EOF'
/**
 * Quick test to verify agentic loop setup
 */

const AgenticLoop = require("./src/core/agentic-loop");

console.log("✓ agentic-loop.js module found");
console.log("✓ Can import AgenticLoop class");
console.log("\n✅ Setup validation passed!\n");

console.log("Next steps:");
console.log("1. Add GEMINI_API_KEY to .env");
console.log("2. Run: node src/search-agent/index.js 'Find React frameworks'");
console.log("3. Monitor iterations in Firebase\n");
EOF
echo -e "${GREEN}✓ test-agentic-setup.js created${NC}"

# Step 5: Summary
echo -e "${BLUE}Step 5: Setup Complete!${NC}"
echo ""
echo -e "${GREEN}=========================================="
echo "✅ AGENTIC LOOP AUTO SETUP COMPLETE"
echo "==========================================${NC}"
echo ""
echo "📦 Files created/updated:"
echo "  ✓ src/core/agentic-loop.js"
echo "  ✓ src/search-agent/index.js (with loop integration)"
echo "  ✓ src/code-agent/tool-registry.js"
echo "  ✓ src/data-agent/tool-registry.js"
echo "  ✓ test-agentic-setup.js"
echo ""
echo "🚀 Quick test:"
echo "  node test-agentic-setup.js"
echo ""
echo "🎯 Run your first autonomous agent:"
echo "  node src/search-agent/index.js 'Find React frameworks and compare them'"
echo ""
echo "📚 Documentation files (already in your repo):"
echo "  - QUICK-REFERENCE.md"
echo "  - AGENTIC-LOOP-INTEGRATION-GUIDE.md"
echo "  - INTEGRATION-EXAMPLES.md"
echo ""
echo -e "${YELLOW}⚠️  Make sure your .env has:${NC}"
echo "  GEMINI_API_KEY=your-key"
echo "  TAVILY_API_KEY=your-key"
echo "  FIREBASE_DATABASE_URL=your-url"
echo ""
