"use client";

import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";

const KEYBOARD_STEP = 16;

type DragState = {
  cursor: string;
  pointerId: number;
  startPosition: number;
  startValue: number;
  userSelect: string;
};

type Maximum = number | (() => number);

function maximumValue(maximum: Maximum) {
  return typeof maximum === "number" ? maximum : maximum();
}

function clamp(value: number, minimum: number, maximum: Maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximumValue(maximum)));
}

export default function ResizeHandle({
  controls,
  defaultValue,
  direction = 1,
  id,
  label,
  maximum,
  minimum,
  onChange,
  orientation = "vertical",
  value,
  valueText,
}: {
  controls: string;
  defaultValue: number;
  direction?: 1 | -1;
  id?: string;
  label: string;
  maximum: Maximum;
  minimum: number;
  onChange: (value: number) => void;
  orientation?: "horizontal" | "vertical";
  value: number;
  valueText: string;
}) {
  const drag = useRef<DragState | null>(null);

  const finishDrag = () => {
    if (!drag.current) return;
    document.documentElement.style.cursor = drag.current.cursor;
    document.body.style.userSelect = drag.current.userSelect;
    drag.current = null;
  };

  useEffect(() => () => {
    if (!drag.current) return;
    document.documentElement.style.cursor = drag.current.cursor;
    document.body.style.userSelect = drag.current.userSelect;
    drag.current = null;
  }, []);

  const change = (next: number) => onChange(clamp(next, minimum, maximum));

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      cursor: document.documentElement.style.cursor,
      pointerId: event.pointerId,
      startPosition: orientation === "vertical" ? event.clientX : event.clientY,
      startValue: value,
      userSelect: document.body.style.userSelect,
    };
    document.documentElement.style.cursor = orientation === "vertical" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const position = orientation === "vertical" ? event.clientX : event.clientY;
    change(current.startValue + (position - current.startPosition) * direction);
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishDrag();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const decreaseKey = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
    const increaseKey = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
    const next = event.key === decreaseKey
      ? value - KEYBOARD_STEP * direction
      : event.key === increaseKey
        ? value + KEYBOARD_STEP * direction
        : event.key === "Home"
          ? minimum
          : event.key === "End"
            ? maximumValue(maximum)
            : null;
    if (next === null) return;
    event.preventDefault();
    change(next);
  };

  return (
    <div
      aria-controls={controls}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemax={typeof maximum === "number" ? maximum : undefined}
      aria-valuemin={minimum}
      aria-valuenow={value}
      aria-valuetext={valueText}
      className={`resize-handle relative z-10 touch-none outline-none ${orientation === "vertical" ? "cursor-col-resize" : "cursor-row-resize"}`}
      data-orientation={orientation}
      id={id}
      onDoubleClick={() => change(defaultValue)}
      onKeyDown={handleKeyDown}
      onLostPointerCapture={finishDrag}
      onPointerCancel={handlePointerUp}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      role="separator"
      tabIndex={0}
    />
  );
}
