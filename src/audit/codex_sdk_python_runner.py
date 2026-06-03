#!/usr/bin/env python3
import argparse
import json
import os
import sys
import time

from openai_codex import Codex, CodexConfig, Sandbox


SANDBOX_BY_VALUE = {
    Sandbox.read_only.value: Sandbox.read_only,
    Sandbox.workspace_write.value: Sandbox.workspace_write,
    Sandbox.full_access.value: Sandbox.full_access,
}
REASONING_EFFORTS = {"minimal", "low", "medium", "high"}


def parse_args():
    parser = argparse.ArgumentParser(description="Run a ContextForge auto-promotion audit with the Codex Python SDK.")
    parser.add_argument("--codex-bin", required=True)
    parser.add_argument("--model", default="gpt-5.5")
    parser.add_argument("--reasoning-effort", default="low")
    parser.add_argument("--sandbox", default=Sandbox.read_only.value)
    parser.add_argument("--cwd", default=os.getcwd())
    return parser.parse_args()


def main():
    args = parse_args()
    try:
        payload = json.load(sys.stdin)
        prompt = payload["prompt"]
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        print(json.dumps({"error": f"Invalid audit payload: {error}"}), file=sys.stderr)
        sys.exit(1)
    sandbox = SANDBOX_BY_VALUE.get(args.sandbox)
    if sandbox is None:
        raise ValueError(f"Unsupported sandbox preset: {args.sandbox}")
    if args.reasoning_effort and args.reasoning_effort not in REASONING_EFFORTS:
        raise ValueError(
            f"Unsupported reasoning effort: {args.reasoning_effort}. "
            f"Expected one of: {', '.join(sorted(REASONING_EFFORTS))}"
        )

    config_overrides = ()
    if args.reasoning_effort:
        config_overrides = (f'model_reasoning_effort="{args.reasoning_effort}"',)

    started_at = time.time()
    config = CodexConfig(
        codex_bin=args.codex_bin,
        cwd=args.cwd,
        config_overrides=config_overrides,
        client_name="contextforge_python_sdk_audit",
        client_title="ContextForge Python SDK Audit",
    )

    with Codex(config) as codex:
        thread = codex.thread_start(
            model=args.model or None,
            sandbox=sandbox,
            cwd=args.cwd,
            ephemeral=True,
        )
        result = thread.run(prompt, sandbox=sandbox)

    print(
        json.dumps(
            {
                "final_response": result.final_response,
                "elapsed_ms": round((time.time() - started_at) * 1000),
            }
        )
    )


if __name__ == "__main__":
    main()
