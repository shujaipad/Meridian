import React from "react";
import { createRoot } from "react-dom/client";
import Meridian from "../../meridian.jsx";

// meridian.jsx was written for the Claude artifact environment, which provides a
// window.storage API. This shim stands in for it locally. Deliberately in-memory
// rather than localStorage-backed: the real price history is far larger than any
// browser storage quota, and persistence across reloads isn't needed to eyeball
// a change.
const mem = new Map();
window.storage = {
  async get(key) {
    return mem.has(key) ? { value: mem.get(key) } : null;
  },
  async set(key, value) {
    mem.set(key, value);
  },
  async delete(key) {
    mem.delete(key);
  },
};

createRoot(document.getElementById("root")).render(<Meridian />);
