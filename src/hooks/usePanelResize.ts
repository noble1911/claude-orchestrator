import { useState, useEffect, useCallback } from "react";

interface PanelResizeConfig {
  leftMin?: number;
  leftMax?: number;
  rightMin?: number;
  rightMax?: number;
  terminalMin?: number;
  terminalMax?: number;
  /** Offset from bottom of window for terminal resize calculation */
  terminalBottomOffset?: number;
}

interface PanelResizeState {
  leftPanelWidth: number;
  rightPanelWidth: number;
  terminalHeight: number;
  /** True when any panel is being resized (useful for adding `select-none`). */
  isResizing: boolean;
  startResizingLeft: () => void;
  startResizingRight: () => void;
  startResizingTerminal: () => void;
}

const DEFAULTS: Required<PanelResizeConfig> = {
  leftMin: 220,
  leftMax: 460,
  rightMin: 280,
  rightMax: 560,
  terminalMin: 120,
  terminalMax: 360,
  terminalBottomOffset: 24,
};

export function usePanelResize(config?: PanelResizeConfig): PanelResizeState {
  const {
    leftMin, leftMax, rightMin, rightMax,
    terminalMin, terminalMax, terminalBottomOffset,
  } = { ...DEFAULTS, ...config };

  const [leftPanelWidth, setLeftPanelWidth] = useState(280);
  const [rightPanelWidth, setRightPanelWidth] = useState(360);
  const [terminalHeight, setTerminalHeight] = useState(180);
  const [isResizingLeft, setIsResizingLeft] = useState(false);
  const [isResizingRight, setIsResizingRight] = useState(false);
  const [isResizingTerminal, setIsResizingTerminal] = useState(false);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (isResizingLeft) {
        setLeftPanelWidth(Math.min(leftMax, Math.max(leftMin, event.clientX)));
      }
      if (isResizingRight) {
        setRightPanelWidth(Math.min(rightMax, Math.max(rightMin, window.innerWidth - event.clientX)));
      }
      if (isResizingTerminal) {
        const next = window.innerHeight - event.clientY - terminalBottomOffset;
        setTerminalHeight(Math.min(terminalMax, Math.max(terminalMin, next)));
      }
    };

    const onMouseUp = () => {
      setIsResizingLeft(false);
      setIsResizingRight(false);
      setIsResizingTerminal(false);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isResizingLeft, isResizingRight, isResizingTerminal,
      leftMin, leftMax, rightMin, rightMax, terminalMin, terminalMax, terminalBottomOffset]);

  const startResizingLeft = useCallback(() => setIsResizingLeft(true), []);
  const startResizingRight = useCallback(() => setIsResizingRight(true), []);
  const startResizingTerminal = useCallback(() => setIsResizingTerminal(true), []);

  return {
    leftPanelWidth,
    rightPanelWidth,
    terminalHeight,
    isResizing: isResizingLeft || isResizingRight || isResizingTerminal,
    startResizingLeft,
    startResizingRight,
    startResizingTerminal,
  };
}
