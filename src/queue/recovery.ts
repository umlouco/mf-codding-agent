import type { NewTask, Task } from './db';

export interface RecoveryVerification {
  implVerifyPrompt?: string;
  solutionVerifyPrompt?: string;
  solutionVerifyCommand?: string;
}

interface PhaseMarker {
  at: number;
  bodyAt: number;
  number: number;
  heading: string;
}

/**
 * Converts a supervisor's accidental multi-phase rewrite into actual queue
 * tasks. A rewrite is one executor turn; numbered, independently verifiable
 * phases are a split even when the supervisor labelled its verdict RETRY.
 */
export function queueTasksFromPhasedRewrite(
  task: Pick<Task, 'title' | 'solutionVerifyCommand'>,
  description: string,
  verification: RecoveryVerification = {},
): NewTask[] | undefined {
  const pattern = /\b(?:phase|step)\s+(\d+)\s*[—–-]\s*([^:\n]{2,100}):\s*/gi;
  const markers: PhaseMarker[] = [];
  for (const match of description.matchAll(pattern)) {
    markers.push({
      at: match.index,
      bodyAt: match.index + match[0].length,
      number: Number(match[1]),
      heading: match[2].trim(),
    });
  }
  if (markers.length < 2 || markers.some((marker) => !Number.isFinite(marker.number))) {
    return undefined;
  }

  const preamble = description.slice(0, markers[0].at).trim();
  const parts = markers.map((marker, index): NewTask => {
    const end = markers[index + 1]?.at ?? description.length;
    const phaseBody = description.slice(marker.bodyAt, end).trim();
    const body = index === 0 && preamble ? `${preamble}\n\n${phaseBody}` : phaseBody;
    const title = `${task.title} — ${marker.heading}`.slice(0, 200);
    const isLast = index === markers.length - 1;
    return {
      title,
      description: body,
      implVerifyPrompt:
        `Inspect the completed work for "${marker.heading}" and record concrete evidence.`,
      solutionVerifyPrompt:
        `Run and evidence only the behavioral checks required by "${marker.heading}".`,
      solutionVerifyCommand: isLast
        ? verification.solutionVerifyCommand || task.solutionVerifyCommand
        : '',
    };
  });

  if (parts.some((part) => part.description.length < 20)) {
    return undefined;
  }
  return parts;
}
