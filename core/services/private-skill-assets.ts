import codeReview from '../../assets/private-engineering-skills/code-review.md'
import codebaseDesign from '../../assets/private-engineering-skills/codebase-design.md'
import commentDiscipline from '../../assets/private-engineering-skills/comment-discipline.md'
import diagnosingBugs from '../../assets/private-engineering-skills/diagnosing-bugs.md'
import domainModeling from '../../assets/private-engineering-skills/domain-modeling.md'
import research from '../../assets/private-engineering-skills/research.md'
import resolvingMergeConflicts from '../../assets/private-engineering-skills/resolving-merge-conflicts.md'
import tdd from '../../assets/private-engineering-skills/tdd.md'
import writingForAgents from '../../assets/private-engineering-skills/writing-for-agents.md'

/** Build-time embedded fallback for standalone binaries, which ship no sidecars. */
export const EMBEDDED_PRIVATE_SKILL_BODIES: Readonly<Record<string, string>> = Object.freeze({
  'code-review.md': codeReview,
  'codebase-design.md': codebaseDesign,
  'comment-discipline.md': commentDiscipline,
  'diagnosing-bugs.md': diagnosingBugs,
  'domain-modeling.md': domainModeling,
  'research.md': research,
  'resolving-merge-conflicts.md': resolvingMergeConflicts,
  'tdd.md': tdd,
  'writing-for-agents.md': writingForAgents,
})
