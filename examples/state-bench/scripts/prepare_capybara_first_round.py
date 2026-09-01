from __future__ import annotations

import argparse
import json

from capybara_first_round.projection import prepare_projection

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Prepare a training-only STATE-Bench trajectory projection")
    parser.add_argument(
        "--cases-per-domain",
        type=int,
        default=None,
        help="Training trajectories selected per domain (default: configured small batch pool)",
    )
    args = parser.parse_args()
    print(json.dumps(prepare_projection(args.cases_per_domain), ensure_ascii=False, indent=2))
