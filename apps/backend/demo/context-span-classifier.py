"""Train, evaluate and serve a file-local classifier for V4 Organizer packets."""

import argparse
import hashlib
import json
import re
from collections import Counter
from copy import deepcopy
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import random
import sys
from time import perf_counter, time
from uuid import uuid4

import torch
from torch import nn
from torch.nn import functional as F
from torch.nn.attention import SDPBackend, sdpa_kernel
from peft import LoraConfig, PeftModel, TaskType, get_peft_model, get_peft_model_state_dict, set_peft_model_state_dict
from transformers import AutoModel, AutoTokenizer


LABELS = ("K", "A", "R")
MODEL_NAME = "qwen-span-classifier"
MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_CACHED_PREFIX_TOKENS = 2048
HOLD_VALIDATION = {"quote-comparison", "projector-room"}
KERNELS = [SDPBackend.CUDNN_ATTENTION, SDPBackend.EFFICIENT_ATTENTION, SDPBackend.FLASH_ATTENTION]
GUIDE = "按任务判断每条原句的相关性。K 保留有用的事实、条件、否定和不同意见。A 明确无关。R 归属或相关性待核对。"


def read_admitted(root, split):
    path = root / f"{split}.jsonl"
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != manifest["fileHashes"][path.name]:
        raise ValueError(f"dataset fingerprint mismatch: {split}")
    for line in raw.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        review = row["provenance"]["semanticReview"]
        if review["decision"] != "accept" or review["split"] != split:
            raise ValueError("review does not authorize this split")
        packet = json.loads(row["messages"][-2]["content"])
        proposal = json.loads(row["messages"][-1]["content"])
        if packet["batch"] != proposal["batch"]:
            raise ValueError("stale supervision binding")
        yield packet, proposal["choices"], review["sourceTaskGroup"]


def task_prefix(packet, tokenizer):
    task = packet["task"]
    background = json.dumps({"任务": task["latestUser"], "排版背景": task["instructions"]}, ensure_ascii=False, separators=(",", ":"))
    phase = "整理选择"
    if task.get("archiveReview"):
        phase = "分段归档复核" if task.get("archiveReviewScope") == "window" else "整份归档复核"
    return tokenizer(f"{GUIDE}\n{phase}\n任务数据 {background}\n", add_special_tokens=False).input_ids


def file_examples(packet, tokenizer, labels=None, prefix=None):
    if packet.get("organizationVersion") != 4 or packet.get("mode") != "organize":
        raise ValueError("classifier requires a file disposition packet")
    grouped = {}
    for index, row in enumerate(packet["sources"]):
        if (row.get("ref") != index + 1 or not isinstance(row.get("file"), str)
                or not isinstance(row.get("text"), str) or type(row.get("line")) is not int
                or row.get("hostMetadata") or row.get("protected")):
            raise ValueError("ineligible file source")
        grouped.setdefault(row["file"], []).append((index, row))
    if not grouped or (labels is not None and len(labels) != len(packet["sources"])):
        raise ValueError("incomplete disposition targets")
    if prefix is None:
        prefix = task_prefix(packet, tokenizer)
    result = []
    for filename, rows in grouped.items():
        ids = prefix + tokenizer("文件 " + json.dumps(filename, ensure_ascii=False) + "\n", add_special_tokens=False).input_ids
        positions, indices = [], []
        for index, row in rows:
            data = json.dumps(row["text"], ensure_ascii=False)
            ids += tokenizer(f"第 {row['line']} 行 {data}\n判定：", add_special_tokens=False).input_ids
            positions.append(len(ids) - 1)
            indices.append(index)
        if len(ids) > 8192:
            raise ValueError("classifier input exceeds configured window")
        result.append((ids, positions, indices, [] if labels is None else [LABELS.index(labels[i]) for i in indices]))
    return result


def model_base(model_path):
    return AutoModel.from_pretrained(model_path, dtype=torch.bfloat16, device_map={"": 0},
                                    attn_implementation="sdpa", trust_remote_code=False, local_files_only=True)


def batch_data(examples, pad):
    width = max(len(item[0]) for item in examples)
    ids, masks, markers, targets = [], [], [], []
    for index, (tokens, positions, _, labels) in enumerate(examples):
        missing = width - len(tokens)
        ids.append(tokens + [pad] * missing)
        masks.append([1] * len(tokens) + [0] * missing)
        markers.extend((index, position) for position in positions)
        targets += labels
    by_row, by_position = zip(*markers)
    arrays = (ids, masks, by_row, by_position, targets)
    return tuple(torch.tensor(array, device="cuda", dtype=torch.long) for array in arrays)


def forward(model, head, examples, pad):
    ids, mask, rows, positions, targets = batch_data(examples, pad)
    h = model(input_ids=ids, attention_mask=mask, use_cache=False).last_hidden_state
    return head(h[rows, positions].float()), targets


@torch.inference_mode()
def probabilities(model, head, examples, pad, chunk=4):
    model.eval()
    with sdpa_kernel(KERNELS):
        return torch.cat([forward(model, head, examples[i:i + chunk], pad)[0].softmax(-1).cpu()
                          for i in range(0, len(examples), chunk)])


@torch.inference_mode()
def probabilities_with_prefix(model, head, examples, prefix, cache=None):
    size = len(prefix)
    with sdpa_kernel(KERNELS):
        if cache is None:
            cache = model(input_ids=torch.tensor([prefix], device="cuda"), use_cache=True).past_key_values
        result = []
        for ids, positions, _, _ in examples:
            suffix = torch.tensor([ids[size:]], device="cuda")
            markers = [position - size for position in positions]
            # Decoder layers append in-place. Each file starts from an independent copy of the common prefix.
            hidden = model(input_ids=suffix, past_key_values=deepcopy(cache), use_cache=True).last_hidden_state
            result.append(head(hidden[0, markers].float()).softmax(-1).cpu())
    return torch.cat(result), cache


class TaskPrefixCache:
    """The service retains at most three phases of one organizer transaction."""

    def __init__(self):
        self.scope = None
        self.states = {}

    def states_for(self, scope):
        if not isinstance(scope, str) or not re.fullmatch(r"context-commit-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", scope):
            scope = None
        if self.scope != scope:
            self.states.clear()
            self.scope = scope
        return self.states if scope is not None else None


def choose(probability, archive_threshold, keep_threshold):
    keep, archive, _ = probability
    best = probability.argmax().item()
    if best == 1 and archive >= archive_threshold:
        return 1
    if best == 0 and keep >= keep_threshold:
        return 0
    return 2


def tally(prob, expected, archive_threshold, keep_threshold):
    result = [[0] * 3 for _ in LABELS]
    for p, gold in zip(prob, expected, strict=True):
        result[gold][choose(p, archive_threshold, keep_threshold)] += 1
    return result


def calibrate(prob, gold):
    candidates = []
    for archive_threshold in (0.5, 0.65, 0.8, 0.9, 0.96, 0.985, 0.99, 0.995, 0.999, 1.01):
        for keep_threshold in (0.5, 0.65, 0.8, 0.9):
            matrix = tally(prob, gold, archive_threshold, keep_threshold)
            candidates.append((calibration_score(matrix), archive_threshold, keep_threshold, matrix))
    return max(candidates)


def calibration_score(matrix):
    unsafe = matrix[0][1] + matrix[2][1]
    return (-unsafe, matrix[0][0] - matrix[1][0] - matrix[2][0], matrix[1][1])


def train(args, tokenizer):
    train_rows = list(read_admitted(args.dataset, "train"))
    validation_rows = list(read_admitted(args.dataset, "validation"))
    held_groups = set(args.validation_group or (HOLD_VALIDATION if not validation_rows else ()))
    train_groups = {group for _, _, group in train_rows}
    if args.validation_group and not held_groups <= train_groups:
        raise ValueError("requested validation group is absent from the training split")
    validation_groups = {group for _, _, group in validation_rows}
    if validation_groups & train_groups:
        raise ValueError("source task group overlaps the training and validation splits")
    validation_rows.extend(row for row in train_rows if row[2] in held_groups)
    train_rows = [row for row in train_rows if row[2] not in held_groups]
    train_examples = [example for packet, labels, _ in train_rows for example in file_examples(packet, tokenizer, labels)]
    validation_examples = [example for packet, labels, _ in validation_rows for example in file_examples(packet, tokenizer, labels)]
    counts = Counter(target for _, _, _, labels in train_examples for target in labels)
    if set(counts) != {0, 1, 2} or not validation_examples:
        raise ValueError("missing disposition training or independent validation group")
    torch.manual_seed(args.seed)
    if args.initialize_from is None:
        base = model_base(args.model)
        model = get_peft_model(base, LoraConfig(r=8, lora_alpha=16, lora_dropout=0.05, task_type=TaskType.FEATURE_EXTRACTION,
                                              target_modules=["q_proj", "k_proj", "v_proj", "o_proj"]))
        head = nn.Linear(base.config.hidden_size, len(LABELS), device="cuda")
    else:
        model, head, initial_archive, initial_keep = load_classifier_from(args.model, args.initialize_from, trainable=True)
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    parameters = [p for p in model.parameters() if p.requires_grad] + list(head.parameters())
    optimizer = torch.optim.AdamW(parameters, lr=args.learning_rate)
    weight = torch.tensor([min(4, (counts[1] / counts[i]) ** 0.5) for i in range(3)], device="cuda")
    rng = random.Random(args.seed)
    pad = tokenizer.pad_token_id
    gold = [target for _, _, _, labels in validation_examples for target in labels]
    best = None
    start = perf_counter()
    first_epoch = 0 if args.initialize_from else 1
    for epoch in range(first_epoch, args.epochs + 1):
        losses = []
        if epoch:
            model.train()
            rng.shuffle(train_examples)
            with sdpa_kernel(KERNELS):
                for i in range(0, len(train_examples), args.batch_size):
                    optimizer.zero_grad(set_to_none=True)
                    logits, targets = forward(model, head, train_examples[i:i + args.batch_size], pad)
                    loss = F.cross_entropy(logits, targets, weight=weight, label_smoothing=args.label_smoothing)
                    loss.backward()
                    nn.utils.clip_grad_norm_(parameters, 1.0)
                    optimizer.step()
                    losses.append(loss.detach().item())
        val = probabilities(model, head, validation_examples, pad)
        if epoch:
            selection = calibrate(val, gold)
        else:
            matrix = tally(val, gold, initial_archive, initial_keep)
            selection = (calibration_score(matrix), initial_archive, initial_keep, matrix)
        if best is None or selection[0] > best[0][0]:
            encoder = {name: value.detach().cpu().clone() for name, value in get_peft_model_state_dict(model).items()}
            linear = {name: value.detach().cpu().clone() for name, value in head.state_dict().items()}
            best = (selection, epoch, encoder, linear, tally(val, gold, 0.5, 0.5))
        print(json.dumps({"epoch": epoch, "loss": sum(losses) / len(losses) if losses else None, "elapsedSeconds": round(perf_counter() - start, 1),
                          "validationMatrix": selection[3]}), flush=True)
    (_, archive, keep, matrix), epoch, encoder, linear, uncalibrated = best
    set_peft_model_state_dict(model, encoder)
    head.load_state_dict(linear)
    args.output.mkdir(parents=True, exist_ok=False)
    model.save_pretrained(args.output / "encoder-adapter")
    torch.save(head.state_dict(), args.output / "head.pt")
    config = {"baseModel": str(args.model), "archiveThreshold": archive, "keepThreshold": keep,
              "seed": args.seed, "learningRate": args.learning_rate,
              "trainingLabels": dict(counts), "trainingFiles": len(train_examples), "validationFiles": len(validation_examples),
              "validationGroups": sorted({group for _, _, group in validation_rows}), "selectionEpoch": epoch, "validationMatrix": matrix,
              "validationUncalibrated": uncalibrated, "labels": LABELS,
              "peakMiB": round(torch.cuda.max_memory_reserved() / 1024 ** 2)}
    if args.initialize_from:
        config["initialClassifier"] = str(args.initialize_from)
    (args.output / "classifier.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
    print(json.dumps(config), flush=True)


def load_classifier_from(model_path, classifier_path, *, trainable=False):
    config = json.loads((classifier_path / "classifier.json").read_text(encoding="utf-8"))
    if tuple(config["labels"]) != LABELS:
        raise ValueError("classifier labels do not match the file disposition protocol")
    archive = config["archiveThreshold"]
    keep = config["keepThreshold"]
    base = model_base(model_path)
    model = PeftModel.from_pretrained(base, classifier_path / "encoder-adapter", is_trainable=trainable).train(trainable)
    head = nn.Linear(base.config.hidden_size, len(LABELS), device="cuda").train(trainable)
    head.load_state_dict(torch.load(classifier_path / "head.pt", map_location="cuda", weights_only=True))
    return model, head, archive, keep


def load_classifier(args):
    return load_classifier_from(args.model, args.classifier)


def disposition_packet(request):
    if not isinstance(request, dict) or not isinstance(request.get("messages"), list) or not request["messages"]:
        raise ValueError("messages must include a V4 Organizer packet")
    message = request["messages"][-1]
    if not isinstance(message, dict) or message.get("role") != "user" or not isinstance(message.get("content"), str):
        raise ValueError("last user message must contain the file disposition packet")
    packet = json.loads(message["content"])
    if not isinstance(packet, dict) or packet.get("organizationVersion") != 4 or packet.get("mode") != "organize":
        raise ValueError("classifier requires a V4 file disposition packet")
    task, sources = packet.get("task"), packet.get("sources")
    if (not isinstance(packet.get("batch"), str) or not packet["batch"].strip()
            or not isinstance(task, dict) or not all(isinstance(task.get(key), str) for key in ("latestUser", "instructions"))
            or not isinstance(sources, list) or not sources or not all(isinstance(row, dict) for row in sources)):
        raise ValueError("incomplete V4 file disposition packet")
    return packet


def predict_dispositions(packet, tokenizer, classifier, chunk=4, reuse_prefix=False, task_cache=None):
    model, head, archive, keep = classifier
    prefix = task_prefix(packet, tokenizer)
    examples = file_examples(packet, tokenizer, prefix=prefix)
    tokens = sum(len(ids) for ids, *_ in examples)
    states = task_cache.states_for(packet["task"].get("prefixCacheScope")) if task_cache is not None else None
    prefix_key = tuple(prefix)
    reusable = states is not None and len(prefix) <= MAX_CACHED_PREFIX_TOKENS
    if reuse_prefix and model.config.model_type == "qwen2" and (reusable or len(examples) > 1):
        cached = states.get(prefix_key) if reusable else None
        prob, cache = probabilities_with_prefix(model, head, examples, prefix, cached)
        tokens -= (len(examples) - 1) * len(prefix)
        if cached is not None:
            tokens -= len(prefix)
        elif reusable and len(states) < 3:
            states[prefix_key] = cache
    else:
        prob = probabilities(model, head, examples, tokenizer.pad_token_id, chunk)
    choices = ["R"] * len(packet["sources"])
    indices = [i for _, _, refs, _ in examples for i in refs]
    for i, p in zip(indices, prob, strict=True):
        choices[i] = LABELS[choose(p, archive, keep)]
    title = packet["task"]["latestUser"].strip()[:100] or "任务文件"
    return {"batch": packet["batch"], "choices": choices, "heading": title}, tokens


def inference(args, tokenizer, classifier):
    model, head, archive, keep = classifier
    if args.dataset:
        examples = []
        for packet, labels, _ in read_admitted(args.dataset, "test"):
            examples.extend(file_examples(packet, tokenizer, labels))
        prob = probabilities(model, head, examples, tokenizer.pad_token_id)
        gold = [label for _, _, _, labels in examples for label in labels]
        matrix = tally(prob, gold, archive, keep)
        print(json.dumps({"model": MODEL_NAME, "testMatrix": matrix,
                          "testUncalibrated": tally(prob, gold, 0.5, 0.5), "labels": LABELS}), flush=True)
        return
    for line in sys.stdin.buffer:
        packet = disposition_packet(json.loads(line))
        start = perf_counter()
        response, tokens = predict_dispositions(packet, tokenizer, classifier)
        print(json.dumps({"provider": "custom", "model": MODEL_NAME, "text": json.dumps(response, ensure_ascii=False),
                          "finishReason": "stop", "usage": {"inputTokens": tokens, "outputTokens": 0},
                          "elapsedSeconds": round(perf_counter() - start, 3)}, ensure_ascii=True), flush=True)


def serve_classifier(port, predict):
    class Handler(BaseHTTPRequestHandler):
        timeout = 15

        def send_json(self, status, value):
            content = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)

        def reject(self, status, message):
            self.send_json(status, {"error": {"message": message, "type": "classifier_request_error"}})

        def do_GET(self):
            if self.path == "/healthz":
                self.send_json(HTTPStatus.OK, {"ready": True, "model": MODEL_NAME})
            else:
                self.reject(HTTPStatus.NOT_FOUND, "unknown route")

        def do_POST(self):
            if self.path != "/v1/chat/completions":
                self.reject(HTTPStatus.NOT_FOUND, "unknown route")
                return
            if self.headers.get_content_type() != "application/json":
                self.reject(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "content type must be application/json")
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size <= 0:
                    raise ValueError("missing body length")
                if size > MAX_REQUEST_BYTES:
                    self.reject(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "classifier request exceeds the body limit")
                    return
                raw = self.rfile.read(size)
                if len(raw) != size:
                    raise ValueError("incomplete body")
                request = json.loads(raw)
            except (ValueError, TimeoutError):
                self.reject(HTTPStatus.BAD_REQUEST, "invalid JSON request body")
                return
            try:
                if (not isinstance(request, dict) or request.get("model") != MODEL_NAME
                        or request.get("stream", False) is not False or request.get("tools")):
                    raise ValueError("expected qwen-span-classifier with non-streaming, tool-free input")
                packet = disposition_packet(request)
                response, tokens = predict(packet)
            except ValueError as error:
                self.reject(HTTPStatus.UNPROCESSABLE_ENTITY, str(error))
                return
            except Exception as error:
                self.log_error("classifier inference failed (%s)", type(error).__name__)
                self.reject(HTTPStatus.INTERNAL_SERVER_ERROR, "classifier inference failed")
                return
            self.send_json(HTTPStatus.OK, {
                "id": f"chatcmpl-{uuid4().hex}", "object": "chat.completion", "created": int(time()), "model": MODEL_NAME,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": json.dumps(response, ensure_ascii=False)},
                             "finish_reason": "stop"}],
                "usage": {"prompt_tokens": tokens, "completion_tokens": 0, "total_tokens": tokens},
            })

    # One inference lane shares the loaded weights and bounds GPU memory use.
    with HTTPServer(("127.0.0.1", port), Handler) as server:
        print(json.dumps({"baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "model": MODEL_NAME}), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    training = modes.add_parser("train")
    training.add_argument("--model", required=True, type=Path)
    training.add_argument("--dataset", required=True, type=Path)
    training.add_argument("--output", required=True, type=Path)
    training.add_argument("--epochs", type=int, default=3)
    training.add_argument("--batch-size", type=int, default=2)
    training.add_argument("--seed", type=int, default=1729)
    training.add_argument("--initialize-from", type=Path, help="continue from an existing adapter and classification head")
    training.add_argument("--learning-rate", type=float, default=0.0002)
    training.add_argument("--label-smoothing", type=float, default=0.07)
    training.add_argument("--validation-group", action="append", help="reserve a reviewed training group for validation")
    predicting = modes.add_parser("infer")
    predicting.add_argument("--model", required=True, type=Path)
    predicting.add_argument("--classifier", required=True, type=Path)
    predicting.add_argument("--dataset", type=Path)
    serving = modes.add_parser("serve")
    serving.add_argument("--model", required=True, type=Path)
    serving.add_argument("--classifier", required=True, type=Path)
    serving.add_argument("--port", type=int, default=8874)
    args = parser.parse_args()
    if not torch.cuda.is_available():
        parser.error("a CUDA device is required for this classifier evaluation")
    if args.mode == "train" and (args.epochs < 1 or args.batch_size < 1 or not 0 <= args.label_smoothing < 1
                                 or not 0 < args.learning_rate < float("inf")):
        parser.error("invalid training epochs, batch size, label smoothing, or learning rate")
    if args.mode == "serve" and not 0 <= args.port <= 65535:
        parser.error("port must be between 0 and 65535")
    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=False, local_files_only=True)
    if tokenizer.pad_token_id is None:
        parser.error("the tokenizer must provide a padding token")
    if args.mode == "train":
        torch.manual_seed(args.seed)
        train(args, tokenizer)
    else:
        classifier = load_classifier(args)
        if args.mode == "infer":
            inference(args, tokenizer, classifier)
        else:
            task_cache = TaskPrefixCache()
            serve_classifier(args.port, lambda packet: predict_dispositions(packet, tokenizer, classifier, chunk=1, reuse_prefix=True, task_cache=task_cache))


if __name__ == "__main__":
    main()
