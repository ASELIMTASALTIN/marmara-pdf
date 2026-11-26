import { setTool, useUi, type Tool } from "../state/uiStore";
import { errorMessage, toast } from "../state/dialogStore";

/** Activates a tool; toggles back to Select when the active tool is chosen again. */
export async function activateTool(t: Tool): Promise<void> {
  const cur = useUi.getState().tool;
  if (cur === t && t !== "select") {
    setTool("select");
    return;
  }
  try {
    if (t === "signature") {
      const { chooseSignature } = await import("../components/annotations/SignatureDialog");
      const sig = await chooseSignature();
      if (!sig) return;
      setTool("signature");
      useUi.setState({ pendingImage: { ...sig, kind: "signature" } });
      return;
    }
    if (t === "image") {
      const { pickImageFile } = await import("../components/annotations/SignatureDialog");
      const img = await pickImageFile();
      if (!img) return;
      setTool("image");
      useUi.setState({ pendingImage: { ...img, kind: "image" } });
      return;
    }
  } catch (e) {
    toast(errorMessage(e), "error");
    return;
  }
  setTool(t);
}
