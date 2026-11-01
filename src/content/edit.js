// Changing text in the page the way typing would, so the page's own code (React, Gmail, Outlook,
// Slack...) sees a normal edit and Cmd+Z undoes it: select the stretch, then insertText.

function selectionFor(el) {
  const root = el.getRootNode();
  return (root.getSelection && root !== document ? root.getSelection() : null) || el.ownerDocument.getSelection();
}

/** Replaces value[start, end) of a textarea or input. */
export function replaceInField(el, start, end, text) {
  el.focus({ preventScroll: true });
  el.setSelectionRange(start, end);
  const doc = el.ownerDocument;
  const ok = text === '' ? doc.execCommand('delete') : doc.execCommand('insertText', false, text);
  if (ok && el.value.slice(start, start + text.length) === text) return true;
  // execCommand refused (rare): set the value through the native setter so frameworks notice.
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  const value = el.value.slice(0, start) + text + el.value.slice(end);
  setter.call(el, value);
  el.setSelectionRange(start + text.length, start + text.length);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }));
  return true;
}

/**
 * Replaces a Range inside a contenteditable editor. First the way Chrome's own spellcheck does it,
 * a beforeinput "insertReplacementText" aimed at the range: editors that keep their own document
 * model (CKEditor 5, Slate, Quill 2) apply it themselves and cancel the event. Editors that don't
 * leave it alone, and insertText does the job instead. Multi-line text goes in as a paste.
 */
export function replaceInEditor(editor, range, text) {
  editor.focus({ preventScroll: true });
  const sel = selectionFor(editor);
  sel.removeAllRanges();
  sel.addRange(range);
  const doc = editor.ownerDocument;
  const data = new DataTransfer();
  data.setData('text/plain', text);
  if (text.includes('\n')) {
    // Editors turn a pasted line break into their own paragraphs; insertText can't do that well.
    const paste = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    editor.dispatchEvent(paste);
    if (paste.defaultPrevented) return true;
  } else {
    const replace = new InputEvent('beforeinput', {
      inputType: 'insertReplacementText', data: text, dataTransfer: data,
      targetRanges: [new StaticRange(range)], bubbles: true, cancelable: true, composed: true,
    });
    editor.dispatchEvent(replace);
    if (replace.defaultPrevented) return true;
  }
  if (text === '') return doc.execCommand('delete');
  return doc.execCommand('insertText', false, text);
}
