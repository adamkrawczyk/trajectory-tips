import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface as createReadlineInterface } from 'node:readline/promises';
import { Command } from 'commander';
import chalk from 'chalk';
import YAML from 'yaml';
import { extractTipsFromInput, importTipsFromInputs } from './extract.js';
import { analyzeTrajectoryIntelligence } from './analyzer.js';
import { batchContrastiveAnalysis } from './contrastive.js';
import { injectTips } from './inject.js';
import { queryTips } from './retrieve.js';
import {
  consolidateTips,
  normalizeTipCandidate,
  recordFeedback,
  reindexAllTips,
  saveTip
} from './store.js';
import { getTipsDir, getIndexPath, loadAllTips, normalizeListOption } from './utils.js';

function printWarnings(warnings = []) {
  for (const warning of warnings) {
    console.error(chalk.yellow(`Warning: ${warning}`));
  }
}

function printTip(tip, score) {
  console.log(chalk.cyan(`${tip.id} [${tip.priority}] (${tip.category}/${tip.domain})`));
  if (typeof score === 'number') {
    console.log(`  score: ${score.toFixed(3)}`);
  }
  console.log(`  content: ${tip.content}`);
  if (tip.trigger) {
    console.log(`  trigger: ${tip.trigger}`);
  }
  if (Array.isArray(tip.tags) && tip.tags.length > 0) {
    console.log(`  tags: ${tip.tags.join(', ')}`);
  }
}

async function promptForAddFields({
  input = process.stdin,
  output = process.stdout,
  createInterface = createReadlineInterface
} = {}) {
  const rl = createInterface({ input, output });
  try {
    const content = (await rl.question('Content: ')).trim();
    const trigger = (await rl.question('Trigger: ')).trim();
    return { content, trigger };
  } finally {
    rl.close();
  }
}

async function addTipFromOptions(options, {
  saveTipImpl = saveTip,
  normalizeTipCandidateImpl = normalizeTipCandidate,
  tipsDir = getTipsDir(),
  indexPath = getIndexPath(),
  embedder,
  promptForFields = promptForAddFields,
  yaml = YAML
} = {}) {
  const trackedOptions = [
    'content',
    'trigger',
    'category',
    'domain',
    'priority',
    'tags',
    'steps',
    'purpose',
    'negativeExample',
    'sourceTrajectory'
  ];

  const hasCliFlags = typeof options.getOptionValueSource === 'function'
    ? trackedOptions.some((name) => options.getOptionValueSource(name) === 'cli')
    : false;

  let content = options.content;
  let trigger = options.trigger;

  if (!hasCliFlags) {
    const prompted = await promptForFields();
    content = prompted.content;
    trigger = prompted.trigger;
  } else if (!content || !trigger) {
    throw new Error('Both --content and --trigger are required unless running with no flags.');
  }

  if (!content || !trigger) {
    throw new Error('Tip content and trigger are required.');
  }

  const steps = normalizeListOption(options.steps);
  const tip = normalizeTipCandidateImpl({
    category: options.category,
    priority: options.priority,
    domain: options.domain,
    content,
    trigger,
    tags: normalizeListOption(options.tags),
    steps: steps || [],
    purpose: options.purpose || '',
    negative_example: options.negativeExample || ''
  }, {
    domain: options.domain,
    sourceTrajectoryId: options.sourceTrajectory || 'manual',
    sourceOutcome: 'irrelevant',
    sourceDescription: options.sourceTrajectory
      ? `Added manually via CLI from trajectory ${options.sourceTrajectory}`
      : 'Added manually via CLI'
  });

  if (options.dryRun) {
    console.log(yaml.stringify(tip, { indent: 2 }).trimEnd());
    return { tip, saved: false, dryRun: true };
  }

  const result = await saveTipImpl(tip, { embedder, tipsDir, indexPath });
  if (result.skipped) {
    console.log(chalk.yellow(`Skipped ${tip.id}: ${result.reason}`));
    return { ...result, saved: false, dryRun: false };
  }

  console.log(chalk.green(`Saved ${tip.id} to ${tipsDir}`));
  return { ...result, saved: true, dryRun: false };
}

export function createProgram(deps = {}) {
  const {
    addTip = addTipFromOptions,
    extractTipsFromInputImpl = extractTipsFromInput,
    analyzeTrajectoryIntelligenceImpl = analyzeTrajectoryIntelligence,
    batchContrastiveAnalysisImpl = batchContrastiveAnalysis,
    injectTipsImpl = injectTips,
    queryTipsImpl = queryTips,
    consolidateTipsImpl = consolidateTips,
    recordFeedbackImpl = recordFeedback,
    reindexAllTipsImpl = reindexAllTips,
    importTipsFromInputsImpl = importTipsFromInputs,
    loadAllTipsImpl = loadAllTips,
    seedBaseTipsImpl,
    embedder,
    promptForFields,
    yaml,
    runtimeContext = {}
  } = deps;

  function resolveContext() {
    return {
      tipsDir: runtimeContext.tipsDir ?? getTipsDir(),
      indexPath: runtimeContext.indexPath ?? getIndexPath(),
      embedder: runtimeContext.embedder ?? embedder
    };
  }

  const program = new Command();
  program
    .name('tips')
    .description('Trajectory-informed memory generation for self-improving agent systems')
    .version('0.1.0');

  program
    .command('add')
    .description('Add a single tip manually')
    .option('--content <content>', 'what to do')
    .option('--trigger <trigger>', 'when this applies')
    .option('--category <category>', 'tip category', 'strategy')
    .option('--domain <domain>', 'tip domain', 'general')
    .option('--priority <priority>', 'tip priority', 'medium')
    .option('--tags <tags>', 'comma-separated tags')
    .option('--steps <steps>', 'comma-separated action steps')
    .option('--purpose <purpose>', 'why this tip matters')
    .option('--negative-example <example>', 'what NOT to do')
    .option('--source-trajectory <id>', 'source trajectory id')
    .option('--dry-run', 'print YAML without writing')
    .action(async (options, command) => {
      const context = resolveContext();
      return addTip({
        ...options,
        getOptionValueSource: (name) => command.getOptionValueSource(name)
      }, {
        tipsDir: context.tipsDir,
        indexPath: context.indexPath,
        embedder: context.embedder,
        promptForFields,
        yaml
      });
    });

  program
    .command('extract')
    .description('Analyze a trajectory file and extract tips')
    .argument('<input>', 'path to trajectory file or - for stdin')
    .option('--section <heading>', 'extract from a specific markdown heading')
    .option('--dry-run', 'show tips without saving')
    .option('--domain <domain>', 'tip domain', 'general')
    .option('--no-analyze', 'skip Phase 1 trajectory analysis (faster, lower quality)')
    .option('--verbose', 'show full analysis output')
    .action(async (input, options) => {
      const context = resolveContext();
      const result = await extractTipsFromInputImpl(input, {
        section: options.section,
        dryRun: options.dryRun,
        domain: options.domain,
        analyze: options.analyze !== false,
        tipsDir: context.tipsDir,
        indexPath: context.indexPath,
        embedder: context.embedder
      });

      console.log(chalk.green(`Outcome: ${result.trajectory_outcome}`));
      if (result.decision_attribution) {
        console.log(`Attribution: ${result.decision_attribution}`);
      }

      // Show analysis summary if available
      if (result.analysis) {
        if (options.verbose) {
          if (result.analysis.failure_chains?.length > 0) {
            console.log(chalk.yellow('\nFailure Chains:'));
            for (const f of result.analysis.failure_chains) {
              console.log(`  Root cause (step ${f.root_cause_step}): ${f.root_cause}`);
              if (f.recovery_method) console.log(`  Recovery (step ${f.recovery_step}): ${f.recovery_method}`);
            }
          }
          if (result.analysis.efficiency_issues?.length > 0) {
            console.log(chalk.yellow('\nEfficiency Issues:'));
            for (const e of result.analysis.efficiency_issues) {
              console.log(`  ${e.issue} → ${e.better_approach}`);
            }
          }
          if (result.analysis.subtask_phases?.length > 0) {
            console.log(chalk.yellow('\nSubtask Phases:'));
            for (const p of result.analysis.subtask_phases) {
              console.log(`  ${p.phase} (${p.outcome}): ${p.transferable_pattern}`);
            }
          }
        } else {
          const fc = result.analysis.failure_chains?.length || 0;
          const ei = result.analysis.efficiency_issues?.length || 0;
          const sp = result.analysis.subtask_phases?.length || 0;
          console.log(chalk.dim(`Analysis: ${fc} failure chain(s), ${ei} efficiency issue(s), ${sp} subtask phase(s)`));
        }
      }

      console.log(chalk.green(`Extracted ${result.tips.length} tip(s)`));
      for (const tip of result.tips) {
        printTip(tip);
      }
      if (options.dryRun) {
        console.log(chalk.yellow('Dry run: nothing saved.'));
      }
    });

  program
    .command('analyze')
    .description('Run Phase 1 trajectory intelligence analysis without extracting tips')
    .argument('<input>', 'path to trajectory file or - for stdin')
    .option('--section <heading>', 'extract from a specific markdown heading')
    .option('--domain <domain>', 'tip domain', 'general')
    .option('--json', 'output raw JSON')
    .action(async (input, options) => {
      const { readTextInput, extractMarkdownSection } = await import('./utils.js');
      const raw = await readTextInput(input);
      const text = extractMarkdownSection(raw, options.section);

      if (text.length < 200) {
        console.log(chalk.yellow('Text too short for meaningful analysis.'));
        return;
      }

      console.log(chalk.dim('Running Phase 1 trajectory analysis...'));
      const analysis = await analyzeTrajectoryIntelligenceImpl(text, { domain: options.domain });

      if (options.json) {
        console.log(JSON.stringify(analysis, null, 2));
        return;
      }

      console.log(chalk.green(`Outcome: ${analysis.outcome}`));

      if (analysis.thought_classification?.length > 0) {
        console.log(chalk.cyan('\nThought Classification:'));
        for (const t of analysis.thought_classification) {
          const icon = t.quality === 'positive' ? '✅' : t.quality === 'negative' ? '❌' : '➖';
          console.log(`  ${icon} Step ${t.step} [${t.type}]: ${t.summary}`);
        }
      }

      if (analysis.decision_chain?.length > 0) {
        console.log(chalk.cyan('\nDecision Chain:'));
        for (const d of analysis.decision_chain) {
          const role = d.causal_role === 'root_cause' ? chalk.red(d.causal_role) :
                       d.causal_role === 'recovery_decision' ? chalk.green(d.causal_role) :
                       chalk.dim(d.causal_role);
          console.log(`  Step ${d.step} [${role}]: ${d.decision}`);
          console.log(`    → ${d.consequence}`);
        }
      }

      if (analysis.failure_chains?.length > 0) {
        console.log(chalk.red('\nFailure Chains:'));
        for (const f of analysis.failure_chains) {
          console.log(`  Symptom step ${f.symptom_step} ← Root cause step ${f.root_cause_step}: ${f.root_cause}`);
          if (f.recovery_method) {
            console.log(chalk.green(`  ↳ Recovered at step ${f.recovery_step}: ${f.recovery_method}`));
          }
        }
      }

      if (analysis.efficiency_issues?.length > 0) {
        console.log(chalk.yellow('\nEfficiency Issues:'));
        for (const e of analysis.efficiency_issues) {
          console.log(`  ⚡ ${e.issue}`);
          console.log(`    Better: ${e.better_approach}`);
        }
      }

      if (analysis.subtask_phases?.length > 0) {
        console.log(chalk.cyan('\nSubtask Phases:'));
        for (const p of analysis.subtask_phases) {
          const icon = p.outcome === 'success' ? '✅' : p.outcome === 'failure' ? '❌' : '⚠️';
          console.log(`  ${icon} ${p.phase}: ${p.transferable_pattern}`);
        }
      }
    });

  program
    .command('query')
    .description('Find relevant tips for a task context')
    .argument('<description>', 'query description')
    .option('--domain <domain>', 'filter by domain')
    .option('--category <category>', 'filter by category')
    .option('--priority <priority>', 'comma-separated priorities')
    .option('--top <n>', 'result limit', '5')
    .option('--json', 'output JSON')
    .action(async (description, options) => {
      const context = resolveContext();
      const result = await queryTipsImpl(description, {
        domain: options.domain,
        category: options.category,
        priority: options.priority,
        top: Number(options.top || 5),
        tipsDir: context.tipsDir,
        indexPath: context.indexPath,
        embedder: context.embedder
      });

      printWarnings(result.warnings);

      if (options.json) {
        const payload = result.results.map((r) => ({ score: r.score, ...r.tip }));
        console.log(JSON.stringify({ method: result.method, results: payload }, null, 2));
        return;
      }

      console.log(chalk.green(`Method: ${result.method}`));
      for (const item of result.results) {
        printTip(item.tip, item.score);
      }
    });

  program
    .command('inject')
    .description('Format relevant tips as prompt-ready section')
    .argument('<description>', 'task description')
    .option('--max-tokens <n>', 'max tokens for injected section', '2000')
    .option('--focus <category>', 'focus category filter')
    .option('--domain <domain>', 'domain filter')
    .action(async (description, options) => {
      const context = resolveContext();
      const result = await injectTipsImpl(description, {
        focus: options.focus,
        maxTokens: Number(options.maxTokens || 2000),
        domain: options.domain,
        tipsDir: context.tipsDir,
        indexPath: context.indexPath,
        embedder: context.embedder,
        queryTipsImpl
      });
      printWarnings(result.warnings);
      console.log(result.prompt);
    });

  program
    .command('list')
    .description('List all stored tips')
    .option('--domain <domain>', 'filter by domain')
    .option('--category <category>', 'filter by category')
    .option('--priority <priority>', 'comma-separated priorities')
    .option('--since <date>', 'ISO date lower bound')
    .option('--stats', 'show stats summary')
    .action(async (options) => {
      const context = resolveContext();
      const { tips, warnings } = await loadAllTipsImpl(context.tipsDir);
      printWarnings(warnings);

      const priorities = normalizeListOption(options.priority);
      const since = options.since ? new Date(options.since) : null;

      const filtered = tips.filter((tip) => {
        if (options.domain && tip.domain !== options.domain) return false;
        if (options.category && tip.category !== options.category) return false;
        if (priorities && !priorities.includes(tip.priority)) return false;
        if (since && new Date(tip.created) < since) return false;
        return true;
      });

      if (options.stats) {
        const byCategory = {};
        const byDomain = {};
        for (const tip of filtered) {
          byCategory[tip.category] = (byCategory[tip.category] || 0) + 1;
          byDomain[tip.domain] = (byDomain[tip.domain] || 0) + 1;
        }
        console.log(JSON.stringify({ total: filtered.length, byCategory, byDomain }, null, 2));
        return;
      }

      for (const tip of filtered) {
        printTip(tip);
      }
      console.log(chalk.green(`Total: ${filtered.length}`));
    });

  program
    .command('consolidate')
    .description('Merge duplicate/overlapping tips')
    .option('--dry-run', 'preview merges')
    .option('--threshold <n>', 'similarity threshold', '0.85')
    .action(async (options) => {
      const context = resolveContext();
      const result = await consolidateTipsImpl({
        dryRun: options.dryRun,
        threshold: Number(options.threshold || 0.85),
        tipsDir: context.tipsDir,
        indexPath: context.indexPath,
        embedder: context.embedder
      });
      printWarnings(result.warnings);
      console.log(JSON.stringify(result, null, 2));
    });

  program
    .command('feedback')
    .description('Record feedback on a tip')
    .argument('<tip-id>', 'tip id')
    .argument('<outcome>', 'success|failure|irrelevant')
    .action(async (tipId, outcome) => {
      const context = resolveContext();
      const result = await recordFeedbackImpl(tipId, outcome, { tipsDir: context.tipsDir });
      console.log(JSON.stringify({
        id: result.id,
        effectiveness: result.effectiveness,
        updated: result.updated
      }, null, 2));
    });

  program
    .command('import')
    .description('Bulk import learnings from existing memory files')
    .argument('<inputs...>', 'one or more files (shell-expanded globs supported)')
    .option('--section <heading>', 'import only a specific section')
    .option('--domain <domain>', 'domain override', 'general')
    .option('--dry-run', 'extract without saving')
    .action(async (inputs, options) => {
      const existing = [];
      for (const input of inputs) {
        const resolved = path.resolve(input);
        try {
          const stat = await fs.stat(resolved);
          if (stat.isFile()) {
            existing.push(resolved);
          }
        } catch {
          // ignore missing; reported below
        }
      }

      if (existing.length === 0) {
        throw new Error('No valid input files found. If using glob patterns, let your shell expand them.');
      }

      const context = resolveContext();
      const results = await importTipsFromInputsImpl(existing, {
        section: options.section,
        domain: options.domain,
        dryRun: options.dryRun,
        tipsDir: context.tipsDir,
        indexPath: context.indexPath,
        embedder: context.embedder
      });

      const summary = {
        files: results.length,
        tips: results.reduce((acc, r) => acc + r.tips.length, 0),
        dryRun: Boolean(options.dryRun)
      };
      console.log(JSON.stringify(summary, null, 2));
    });

  program
    .command('reindex')
    .description('Rebuild embeddings index from tip YAML files')
    .action(async () => {
      const context = resolveContext();
      const result = await reindexAllTipsImpl({
        tipsDir: context.tipsDir,
        indexPath: context.indexPath,
        embedder: context.embedder
      });
      printWarnings(result.warnings);
      console.log(chalk.green(`Reindexed ${result.count} tip(s)`));
    });

  program
    .command('seed')
    .description('Seed tip store with base tips (for new client provisioning)')
    .option('--base-dir <dir>', 'base tips source directory')
    .option('--skip-embeddings', 'copy YAMLs without generating embeddings')
    .action(async (options) => {
      const { seedBaseTips } = await import('./seed.js');
      const context = resolveContext();
      const activeSeedBaseTips = seedBaseTipsImpl || seedBaseTips;
      const result = await activeSeedBaseTips({
        baseDir: options.baseDir,
        skipEmbeddings: options.skipEmbeddings,
        tipsDir: context.tipsDir,
        indexPath: context.indexPath,
        embedder: context.embedder
      });
      console.log(chalk.green(`Seeded ${result.count} base tip(s)`));
      if (result.skipped > 0) {
        console.log(chalk.yellow(`Skipped ${result.skipped} (already exist)`));
      }
    });

  program
    .command('contrast')
    .description('Compare multiple trajectory files and extract contrastive tips')
    .argument('<files...>', 'two or more trajectory/log files to compare')
    .option('--domain <domain>', 'tip domain', 'general')
    .option('--dry-run', 'show tips without saving')
    .option('--json', 'output raw JSON')
    .action(async (files, options) => {
      if (files.length < 2) {
        console.error(chalk.red('Need at least 2 files to compare.'));
        process.exit(1);
      }

      const { readTextInput } = await import('./utils.js');
      const trajectories = [];
      for (const f of files) {
        const text = await readTextInput(f);
        trajectories.push({
          path: f,
          text,
          label: path.basename(f, path.extname(f))
        });
      }

      console.log(chalk.dim(`Analyzing ${trajectories.length} trajectories...`));
      const context = resolveContext();
      const results = await batchContrastiveAnalysisImpl(trajectories, {
        domain: options.domain,
        dryRun: options.dryRun,
        tipsDir: context.tipsDir,
        indexPath: context.indexPath,
        embedder: context.embedder
      });

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      if (results.length === 0) {
        console.log(chalk.yellow('No contrastive insights found (trajectories may be too similar).'));
        return;
      }

      for (const r of results) {
        console.log(chalk.cyan(`\n${r.comparison} → ${r.outcome}`));
        if (r.differences?.length > 0) {
          for (const d of r.differences) {
            console.log(`  ${d.winner === 'A' ? '✓' : d.winner === 'B' ? '✗' : '·'} ${d.aspect}: ${d.insight}`);
          }
        }
        if (r.tips?.length > 0) {
          console.log(chalk.green(`  Tips extracted: ${r.tips.length}`));
          for (const tip of r.tips) {
            console.log(`    [${tip.category}] ${tip.content.slice(0, 100)}`);
          }
        }
      }

      if (options.dryRun) {
        console.log(chalk.yellow('\nDry run: nothing saved.'));
      }
    });

  program
    .command('health')
    .description('Show tip effectiveness stats, identify stale/failing tips')
    .option('--json', 'output JSON')
    .action(async (options) => {
      const context = resolveContext();
      const { tips, warnings } = await loadAllTipsImpl(context.tipsDir);
      printWarnings(warnings);

      const stats = {
        total: tips.length,
        withFeedback: 0,
        proven: [],      // ≥3 applied, ≥80% success
        unreliable: [],  // ≥3 applied, <30% success
        stale: [],       // never applied, >30 days old
        noFeedback: 0
      };

      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

      for (const tip of tips) {
        const eff = tip.effectiveness || {};
        const applied = Number(eff.applied_count || 0);
        const successes = Number(eff.success_count || 0);

        if (applied === 0) {
          stats.noFeedback++;
          const created = new Date(tip.created || 0).getTime();
          if (created < thirtyDaysAgo) {
            stats.stale.push({ id: tip.id, content: tip.content.slice(0, 60), created: tip.created });
          }
          continue;
        }

        stats.withFeedback++;
        const rate = successes / applied;

        if (applied >= 3 && rate >= 0.8) {
          stats.proven.push({ id: tip.id, content: tip.content.slice(0, 60), rate: Math.round(rate * 100), applied });
        }
        if (applied >= 3 && rate < 0.3) {
          stats.unreliable.push({ id: tip.id, content: tip.content.slice(0, 60), rate: Math.round(rate * 100), applied });
        }
      }

      if (options.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      console.log(chalk.green(`Total tips: ${stats.total}`));
      console.log(`  With feedback: ${stats.withFeedback}`);
      console.log(`  No feedback yet: ${stats.noFeedback}`);

      if (stats.proven.length > 0) {
        console.log(chalk.green(`\n✅ Proven tips (${stats.proven.length}):`));
        for (const t of stats.proven) {
          console.log(`  ${t.id} — ${t.rate}% success (${t.applied}x) — ${t.content}`);
        }
      }

      if (stats.unreliable.length > 0) {
        console.log(chalk.red(`\n⚠️ Unreliable tips (${stats.unreliable.length}) — consider archiving:`));
        for (const t of stats.unreliable) {
          console.log(`  ${t.id} — ${t.rate}% success (${t.applied}x) — ${t.content}`);
        }
      }

      if (stats.stale.length > 0) {
        console.log(chalk.yellow(`\n💤 Stale tips (${stats.stale.length}) — never applied, >30 days old:`));
        for (const t of stats.stale) {
          console.log(`  ${t.id} — created ${t.created} — ${t.content}`);
        }
      }
    });

  return program;
}

export async function run(argv = process.argv) {
  const program = createProgram();
  await program.parseAsync(argv);
}
