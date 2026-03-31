import type { FailureClass } from "../types.js";

export interface ParsedTerminalLog {
  parserSupported: boolean;
  rounds?: number;
  terminationReason?: string;
  systemFailure: boolean;
  failureClass?: FailureClass;
}

const SUPPORTED_SHA = "5f7d500b5e5cb9287cf1b2ca57071b6cb98cdcea";

function classifySystemFailure(lines: string[]): Pick<ParsedTerminalLog, "systemFailure" | "failureClass"> {
  for (const line of lines) {
    if (line.startsWith("[ERROR] No API key configured")) {
      return { systemFailure: true, failureClass: "missing_api_key" };
    }

    if (line.startsWith("[TIMEOUT]")) {
      return { systemFailure: true, failureClass: "timeout" };
    }

    if (line.startsWith("[ERROR] Saboteur call failed")) {
      return { systemFailure: true, failureClass: "saboteur_error" };
    }

    if (line.startsWith("[ERROR] Judge call failed")) {
      return { systemFailure: true, failureClass: "judge_error" };
    }
  }

  return { systemFailure: false };
}

function parseRounds(lines: string[]): number | undefined {
  for (const line of lines) {
    const verdictMatch = /\[VERDICT\].*?\brounds=(\d+)/.exec(line);
    if (verdictMatch) {
      return Number.parseInt(verdictMatch[1], 10);
    }
  }

  const saboteurRounds = lines
    .map((line) => /\[SABOTEUR R(\d+)\]/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number.parseInt(match[1], 10));

  if (saboteurRounds.length > 0) {
    return Math.max(...saboteurRounds);
  }

  return undefined;
}

function parseTerminationReason(lines: string[]): string | undefined {
  for (const line of lines) {
    if (line.startsWith("[VERDICT] DENY (max depth reached)")) {
      return "max_depth_reached";
    }

    if (line.startsWith("[VERDICT] DENY")) {
      return "judge_deny";
    }

    if (line.startsWith("[VERDICT] ALLOW")) {
      return "judge_allow_concordance_threshold";
    }
  }

  for (const line of lines) {
    if (line.startsWith("[TIMEOUT]")) {
      return "timeout";
    }

    if (line.startsWith("[ERROR] No API key configured")) {
      return "missing_api_key";
    }

    if (line.startsWith("[ERROR] Saboteur call failed")) {
      return "saboteur_error";
    }

    if (line.startsWith("[ERROR] Judge call failed")) {
      return "judge_error";
    }
  }

  return undefined;
}

export function parseTerminalLog(
  validatorGitSha: string,
  terminalLog: string[],
): ParsedTerminalLog {
  if (validatorGitSha !== SUPPORTED_SHA) {
    return {
      parserSupported: false,
      systemFailure: false,
    };
  }

  const failure = classifySystemFailure(terminalLog);
  return {
    parserSupported: true,
    rounds: parseRounds(terminalLog),
    terminationReason: parseTerminationReason(terminalLog),
    ...failure,
  };
}
