# Claude Code Auto Setup Instructions

## Goal
Use Claude Code in auto mode to automatically integrate the agentic loop into your agents-system project.

---

## 📋 Setup Steps

### 1. Download the setup script
Get `setup-agentic-loop.sh` from the output files above.

### 2. Add it to your project
```bash
# Copy to your agents-system root directory
cp setup-agentic-loop.sh /path/to/agents-system/
chmod +x setup-agentic-loop.sh
```

### 3. Open Claude Code
```bash
# From agents-system directory
claude code
```

This opens Claude Code's editor with your project.

### 4. Run the setup in auto mode

In Claude Code terminal, type:
```bash
./setup-agentic-loop.sh
```

Or let Claude Code run it for you:

**Option A: Ask Claude Code directly (auto mode)**
```
Run the setup-agentic-loop.sh script to install agentic loop into this project
```

Claude Code will:
- ✅ Execute the script
- ✅ Create all necessary files
- ✅ Update your agents
- ✅ Create test files
- ✅ Show you results in real-time

**Option B: Use it from the terminal**
```bash
# In Claude Code's integrated terminal
./setup-agentic-loop.sh
```

---

## What the Script Does

### Phase 1: Core Module (5 sec)
- Creates `src/core/agentic-loop.js` (the loop engine)
- ~390 lines of plan-execute-reflect logic

### Phase 2: Search Agent (2 sec)
- Updates `src/search-agent/index.js` to use the loop
- Adds tool registry (search, write, think)
- Makes it fully autonomous

### Phase 3: Tool Registries (2 sec)
- Creates `src/code-agent/tool-registry.js`
- Creates `src/data-agent/tool-registry.js`
- Templates ready for other agents

### Phase 4: Test File (1 sec)
- Creates `test-agentic-setup.js`
- Quick validation that setup worked

### Total Time: ~30 seconds

---

## ✅ After Setup Completes

The script will show:
```
✅ AGENTIC LOOP AUTO SETUP COMPLETE
=========================================

📦 Files created/updated:
  ✓ src/core/agentic-loop.js
  ✓ src/search-agent/index.js (with loop integration)
  ✓ src/code-agent/tool-registry.js
  ✓ src/data-agent/tool-registry.js
  ✓ test-agentic-setup.js

🚀 Quick test:
  node test-agentic-setup.js

🎯 Run your first autonomous agent:
  node src/search-agent/index.js 'Find React frameworks and compare them'
```

---

## 🧪 Verify It Works

### 1. Quick validation test
```bash
node test-agentic-setup.js
```

Should show:
```
✓ agentic-loop.js module found
✓ Can import AgenticLoop class

✅ Setup validation passed!
```

### 2. Run your first autonomous agent
```bash
node src/search-agent/index.js "Find Python web frameworks"
```

Should show:
```
🎯 Starting agentic loop for goal: "Find Python web frameworks"

━━━ ITERATION 1 ━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 Planned 2 steps
  1. [search] Find popular Python web frameworks
  2. [write] Summarize findings
✅ Executed 2 steps
  → Executing: [search] Find popular Python web frameworks
    ✓ Success (1.23s)
  → Executing: [write] Summarize findings
    ✓ Success (0.45s)
🔄 Not yet complete. Need more analysis.

━━━ ITERATION 2 ━━━━━━━━━━━━━━━━━━━━━━━━━━
...continues looping until goal is complete...
```

---

## 🔧 Manual Override

If you prefer to manually add files, you can still use Claude Code:

1. Open the project in Claude Code
2. Create `src/core/agentic-loop.js` manually
3. Copy the agentic-loop.js content from the outputs
4. Update your agents individually

But the script is faster! ⚡

---

## 📝 Customize After Setup

After the script runs, you can modify:

**Search Agent** (`src/search-agent/index.js`)
- Add your own search parameters
- Change goal examples
- Adjust maxIterations (currently 20)

**Tool Registries** (e.g., `src/code-agent/tool-registry.js`)
- Add more detailed implementations
- Connect to your actual APIs
- Handle errors your way

**Test File** (`test-agentic-setup.js`)
- Modify to test your specific agents
- Add more validation checks

---

## ⚠️ Prerequisites

Make sure you have:
- Node.js 16+ installed
- `.env` file with:
  ```
  GEMINI_API_KEY=your-gemini-key
  TAVILY_API_KEY=your-tavily-key
  FIREBASE_DATABASE_URL=your-db-url
  FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
  ```
- Firebase configured (should already be done)

---

## 🆘 Troubleshooting

### "command not found: ./setup-agentic-loop.sh"
Make sure you're in the agents-system root directory:
```bash
pwd  # Should show: /path/to/agents-system
ls setup-agentic-loop.sh  # Should find the file
chmod +x setup-agentic-loop.sh
./setup-agentic-loop.sh
```

### "Permission denied"
```bash
chmod +x setup-agentic-loop.sh
./setup-agentic-loop.sh
```

### Script runs but files don't appear
- Check that you have write permissions
- Make sure src/core/ directory exists
- Try running without ./ prefix: `bash setup-agentic-loop.sh`

### Files created but imports fail
- Make sure `@google/generative-ai` is installed: `npm install @google/generative-ai`
- Check that agentic-loop.js is in `src/core/`
- Verify other imports exist (memory, axios)

---

## 📚 Next Steps

After setup:

1. **Test the search agent** (5 min)
   ```bash
   node src/search-agent/index.js "Find React state management libraries"
   ```

2. **Integrate other agents** (30 min each)
   - Code Agent: Update `src/code-agent/index.js`
   - Data Agent: Update `src/data-agent/index.js`
   - etc.

3. **Read the docs** (reference while implementing)
   - QUICK-REFERENCE.md (2 min read)
   - INTEGRATION-EXAMPLES.md (copy-paste code)
   - AGENTIC-LOOP-INTEGRATION-GUIDE.md (deep dive)

4. **Test everything**
   - Run `node test-agentic-setup.js`
   - Check Firebase for session tracking
   - Verify iterations increment

5. **Deploy** (when ready)
   - Push to GitHub
   - Deploy to Vercel
   - Keep running 24/7

---

## ✨ Summary

**In 30 seconds with one command:**
- ✅ Install agentic loop core module
- ✅ Make search agent fully autonomous
- ✅ Create templates for other agents
- ✅ Generate test file

**Then in 5 minutes:**
- Test the search agent
- Verify it loops autonomously
- See iterations in Firebase

**You're ready to deploy!** 🚀

---

## 🎯 What You Get

After running the setup:

```
agents-system/
├── src/
│   ├── core/
│   │   ├── agentic-loop.js        ← NEW (the loop engine)
│   │   ├── memory.js              (existing)
│   │   └── runner.js              (existing)
│   ├── search-agent/
│   │   └── index.js               (UPDATED with loop)
│   ├── code-agent/
│   │   ├── index.js               (unchanged)
│   │   └── tool-registry.js       ← NEW (template)
│   ├── data-agent/
│   │   └── tool-registry.js       ← NEW (template)
│   └── ... (other agents)
├── setup-agentic-loop.sh           (the script you ran)
├── test-agentic-setup.js           ← NEW (validation test)
└── package.json
```

Every file is ready to use. Your agents are now autonomous! 🎉

---

## Questions?

Check the documentation:
- **"How do I use Claude Code?"** → This file
- **"What did the script create?"** → What You Get section above
- **"How do I customize?"** → INTEGRATION-EXAMPLES.md
- **"It's not working"** → Troubleshooting section above

Good luck! 🚀
