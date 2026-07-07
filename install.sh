#!/bin/bash

# 🚀 Agentic Loop One-Line Setup for Claude Code
# 
# Usage in Claude Code terminal:
#   curl -sSL https://your-url/install.sh | bash
#   
# Or run locally:
#   bash <(curl -s https://your-url/install.sh)

set -e

echo "🚀 Agentic Loop Auto Install for Claude Code"
echo "=============================================="
echo ""

# Check we're in the right directory
if [ ! -f "package.json" ] || [ ! -d "src" ]; then
  echo "❌ Error: Run from agents-system root directory"
  exit 1
fi

echo "📦 Installing agentic loop..."

# Create the core module inline
mkdir -p src/core

cat > src/core/agentic-loop.js << 'AGENTIC_LOOP_EOF'
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
    console.log(`\n🎯 Agentic loop: "${goal}"\n`);

    const context = await this.memory.getContext(this.sessionId);
    let isComplete = false;
    let completionReason = "";

    while (this.iterationCount < this.maxIterations && !isComplete) {
      console.log(`━━━ ITERATION ${this.iterationCount + 1} ━━━━━━━━━━━━━━━━━━`);

      try {
        const planResult = await this._plan(goal, context);
        if (!planResult.steps || planResult.steps.length === 0) {
          isComplete = true;
          completionReason = planResult.reasoning;
          break;
        }

        await this.memory.addSteps(this.sessionId, planResult.steps);
        console.log(`📋 ${planResult.steps.length} steps planned`);

        const executionResults = await this._executeSteps(planResult.steps);
        console.log(`✅ ${executionResults.length} steps executed`);

        const reflection = await this._reflect(goal, planResult, executionResults, context);
        await this.memory.updateContext(this.sessionId, {
          accumulated_knowledge: reflection.updatedKnowledge,
          last_reflection: reflection.analysis,
          steps_executed: this.iterationCount + 1,
        });

        if (reflection.isGoalComplete) {
          isComplete = true;
          completionReason = reflection.completionReason;
          console.log(`🎉 Goal complete!`);
        } else {
          console.log(`🔄 Continuing...`);
        }

        this.iterationCount++;
      } catch (error) {
        console.error(`❌ Iteration ${this.iterationCount + 1} error:`, error.message);
        this.iterationCount++;
      }
    }

    await this.memory.completeSession(this.sessionId, {
      success: isComplete,
      result: completionReason,
      iterations: this.iterationCount,
    });

    return {
      success: isComplete,
      result: completionReason,
      iterations: this.iterationCount,
    };
  }

  async _plan(goal, context) {
    const model = this.gemini.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `Goal: "${goal}"\nContext: ${context?.accumulated_knowledge || "none"}\n\nPlan 2-3 next steps. Respond in JSON: {"reasoning":"...","steps":[{"action":"search|code|data|file|write|db|think","description":"...","params":{}}]}`;
    
    try {
      const response = await model.generateContent(prompt);
      const text = response.response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : '{"steps":[]}');
      return { reasoning: parsed.reasoning || "Plan", steps: parsed.steps || [] };
    } catch (e) {
      return { reasoning: "Error", steps: [] };
    }
  }

  async _executeSteps(steps) {
    const results = [];
    for (const step of steps) {
      try {
        console.log(`  → [${step.action}] ${step.description}`);
        const result = await this.tools[step.action](step.params || {});
        results.push({ action: step.action, success: true, result });
        console.log(`    ✓`);
      } catch (error) {
        results.push({ action: step.action, success: false, error: error.message });
        console.log(`    ✗ ${error.message}`);
      }
    }
    return results;
  }

  async _reflect(goal, planResult, executionResults, context) {
    const model = this.gemini.getGenerativeModel({ model: "gemini-1.5-flash" });
    const summary = executionResults.map(r => `[${r.action}] ${r.success ? "✓" : "✗"}`).join(", ");
    const prompt = `Goal: "${goal}"\nResults: ${summary}\n\nIs goal complete? Respond in JSON: {"isGoalComplete":true/false,"completionReason":"...","nextAction":"...","updatedKnowledge":"...","analysis":"..."}`;
    
    try {
      const response = await model.generateContent(prompt);
      const text = response.response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : '{"isGoalComplete":false}');
      return {
        isGoalComplete: parsed.isGoalComplete || false,
        completionReason: parsed.completionReason || "Incomplete",
        nextAction: parsed.nextAction || "Continue",
        updatedKnowledge: parsed.updatedKnowledge || "",
        analysis: parsed.analysis || "",
      };
    } catch (e) {
      return {
        isGoalComplete: false,
        completionReason: "Reflection error",
        nextAction: "Retry",
        updatedKnowledge: "",
        analysis: "",
      };
    }
  }
}

module.exports = AgenticLoop;
AGENTIC_LOOP_EOF

echo "✓ agentic-loop.js created"

# Update search agent
cat > src/search-agent/index.js << 'SEARCH_AGENT_EOF'
const AgenticLoop = require("../core/agentic-loop");
const memory = require("../core/memory");
const axios = require("axios");

const toolRegistry = {
  async search(params) {
    const { query } = params;
    try {
      const res = await axios.get("https://api.tavily.com/search", {
        params: {
          api_key: process.env.TAVILY_API_KEY,
          query,
          max_results: 10,
        },
      });
      return JSON.stringify({ count: res.data.results.length, results: res.data.results });
    } catch (e) {
      throw new Error(`Search: ${e.message}`);
    }
  },
  async write(params) {
    return `Written: ${params.topic || "content"}`;
  },
  async think(params) {
    return "Thought.";
  },
};

async function main() {
  const goal = process.argv[2] || "Find React frameworks and compare them";
  
  try {
    console.log(`\n🎯 Search Agent: ${goal}\n`);
    
    await memory.initFirebase();
    const sessionId = await memory.createSession(goal, "search-agent");
    
    const loop = new AgenticLoop(sessionId, memory, process.env.GEMINI_API_KEY, toolRegistry);
    const result = await loop.run(goal, 20);
    
    console.log("\n" + "=".repeat(50));
    console.log(`✅ Complete (${result.iterations} iterations)`);
    console.log("=".repeat(50) + "\n");
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
}

main();
SEARCH_AGENT_EOF

echo "✓ search-agent/index.js updated"

# Quick test
cat > test-agentic.js << 'TEST_EOF'
console.log("✓ Testing agentic-loop.js import...");
const AgenticLoop = require("./src/core/agentic-loop");
console.log("✓ AgenticLoop class loaded");
console.log("\n✅ Setup successful!\n");
console.log("Next step: node src/search-agent/index.js 'Your goal here'\n");
TEST_EOF

echo "✓ test-agentic.js created"

echo ""
echo "✅ INSTALLATION COMPLETE"
echo ""
echo "Quick test:"
echo "  node test-agentic.js"
echo ""
echo "Run an autonomous agent:"
echo "  node src/search-agent/index.js 'Find React frameworks'"
echo ""
