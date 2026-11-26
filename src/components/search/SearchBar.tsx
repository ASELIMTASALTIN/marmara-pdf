import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, X, CaseSensitive, WholeWord, Loader2 } from "lucide-react";
import { useSearch } from "../../state/searchStore";
import { useDoc } from "../../state/documentStore";
import { clearSearch, nextHit, runSearch } from "../../actions/searchActions";
import { IconButton } from "../common/IconButton";

export function SearchBar() {
  const { open, query, matchCase, wholeWord, hits, active, running, scanned } = useSearch();
  const pdf = useDoc((s) => s.pdf);
  const pages = useDoc((s) => s.pageSizes.length);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Re-run (debounced) when the query/options change or the document changes.
  useEffect(() => {
    if (!open) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void runSearch(), 220);
    return () => clearTimeout(timer.current);
  }, [query, matchCase, wholeWord, pdf, open]);

  if (!open) return null;

  const close = () => {
    clearSearch();
    useSearch.setState({ open: false });
    document.querySelector<HTMLElement>(".viewer")?.focus();
  };

  let status = "";
  if (query.trim()) {
    if (hits.length) status = `${active + 1} of ${hits.length}${running ? "+" : ""}`;
    else status = running ? `Searching… ${Math.round((scanned / Math.max(1, pages)) * 100)}%` : "No results";
  }

  return (
    <div className="search-bar" role="search">
      <input
        id="search-input"
        className="search-input"
        placeholder="Find in document"
        value={query}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => useSearch.setState({ query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            nextHit(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      />
      <span className="search-status" aria-live="polite">
        {running && <Loader2 size={13} className="spin" />}
        {status}
      </span>
      <IconButton icon={CaseSensitive} label="Match case" active={matchCase} size={17} onClick={() => useSearch.setState({ matchCase: !matchCase })} />
      <IconButton icon={WholeWord} label="Whole words" active={wholeWord} size={17} onClick={() => useSearch.setState({ wholeWord: !wholeWord })} />
      <IconButton icon={ChevronUp} label="Previous match" command="search.prev" disabled={!hits.length} onClick={() => nextHit(-1)} />
      <IconButton icon={ChevronDown} label="Next match" command="search.next" disabled={!hits.length} onClick={() => nextHit(1)} />
      <IconButton icon={X} label="Close search" onClick={close} />
    </div>
  );
}
