// src/screens/Library.tsx
// Your Fortnite builds. Selecting one is what Play uses.
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Trash2, Check, FolderOpen, HardDrive } from "lucide-react";
import { Button, Card, EmptyState, Badge } from "../ui/primitives";
import type { LauncherApi } from "../useLauncher";

export default function Library({ api }: { api: LauncherApi }) {
  const selected = api.path || api.builds[0]?.path || null;

  return (
    <div className="px-8 py-7 max-w-5xl">
      <header className="flex items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="font-display text-[26px] font-bold text-text">Library</h1>
          <p className="text-[13px] text-muted mt-1">
            {api.builds.length === 0
              ? "No builds yet."
              : `${api.builds.length} of 16 builds. The selected one launches when you press Play.`}
          </p>
        </div>
        {api.builds.length > 0 && (
          <Button variant="secondary" icon={<Plus aria-hidden size={16} />} onClick={api.addBuild}>
            Add build
          </Button>
        )}
      </header>

      {api.builds.length === 0 ? (
        <Card>
          <EmptyState
            icon={<HardDrive aria-hidden size={22} />}
            title="Add your Fortnite build"
            body="Point Nova at a Fortnite 7.40 folder — the one containing the Engine directory. Nova reads the splash art for the cover and never modifies your files."
            action={
              <Button icon={<FolderOpen aria-hidden size={16} />} onClick={api.addBuild}>
                Choose a folder
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3.5">
          <AnimatePresence initial={false}>
            {api.builds.map((b, i) => {
              const isSelected = b.path === selected;
              return (
                <motion.div
                  key={b.id}
                  layout
                  initial={{ opacity: 0, scale: 0.95, y: 12 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
                  // Staggered on first paint only — a wave, then stillness.
                  transition={{ duration: 0.36, delay: Math.min(i * 0.05, 0.3), ease: [0.16, 1, 0.3, 1] }}
                >
                  <div
                    className={[
                      "group relative rounded-[var(--radius-card)] overflow-hidden border bg-surface transition-colors duration-200",
                      isSelected ? "border-frost/60" : "border-line hover:border-line-strong",
                    ].join(" ")}
                  >
                    {/* Selecting is the primary action, so the whole card is the control. */}
                    <button
                      onClick={() => api.setPath(b.path)}
                      aria-pressed={isSelected}
                      className="block w-full text-left cursor-pointer"
                    >
                      <div className="aspect-[16/9] bg-surface-2 relative overflow-hidden">
                        {b.coverDataUrl ? (
                          <img
                            src={b.coverDataUrl}
                            // Decorative: the build's name is right below it in text.
                            alt=""
                            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.04] motion-reduce:transform-none"
                          />
                        ) : (
                          <div className="w-full h-full grid place-items-center text-faint">
                            <HardDrive aria-hidden size={26} />
                          </div>
                        )}
                        <div className="absolute inset-0 bg-gradient-to-t from-ink/85 via-transparent to-transparent" />
                        {isSelected && (
                          <span className="absolute top-2.5 right-2.5">
                            <Badge tone="frost"><Check aria-hidden size={11} />Selected</Badge>
                          </span>
                        )}
                      </div>
                      <div className="px-3.5 py-3">
                        <p className="text-[13.5px] font-semibold text-text truncate">{b.name}</p>
                        <p className="text-[11.5px] text-faint font-mono truncate mt-0.5 selectable" title={b.path}>
                          {b.path}
                        </p>
                      </div>
                    </button>

                    <button
                      onClick={() => api.removeBuild(b.id)}
                      aria-label={`Remove ${b.name} from your library`}
                      className="absolute top-2.5 left-2.5 size-8 grid place-items-center rounded-lg bg-ink/70 backdrop-blur text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-bad transition-opacity duration-200 cursor-pointer"
                    >
                      <Trash2 aria-hidden size={14} />
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      <p className="text-[12.5px] text-faint mt-5 leading-relaxed max-w-lg">
        Removing a build only takes it out of this list. Nothing is deleted from your disk.
      </p>
    </div>
  );
}
