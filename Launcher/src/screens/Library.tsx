// src/screens/Library.tsx
// Your Fortnite builds. Selecting one is what Play uses.
import { motion, AnimatePresence } from "motion/react";
import { listItemVariants } from "../motion";
import { Plus, Trash2, Check, FolderOpen, HardDrive } from "lucide-react";
import { Button, Card, EmptyState, Badge } from "../ui/primitives";
import type { LauncherApi } from "../useLauncher";

export default function Library({ api }: { api: LauncherApi }) {
  const selected = api.path || api.builds[0]?.path || null;

  return (
    <div className="px-8 py-7 max-w-5xl">
      <header className="flex items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="font-display text-2xl font-bold text-text">Library</h1>
          <p className="text-sm text-text-2 mt-1">
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
                  custom={i}
                  variants={listItemVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                >
                  <div
                    className={[
                      "group relative rounded-[var(--radius-lg)] overflow-hidden border bg-surface-1 transition-colors duration-200",
                      isSelected ? "border-accent/60" : "border-hairline hover:border-edge",
                    ].join(" ")}
                  >
                    {/* Selecting is the primary action, so the whole card is the control. */}
                    <button
                      onClick={() => api.setPath(b.path)}
                      aria-pressed={isSelected}
                      className="block w-full text-left cursor-pointer"
                    >
                      <div className="aspect-[16/9] bg-surface-2 relative overflow-hidden group-hover:[&>.hover-zoom]:scale-[1.03]">
                        {b.coverDataUrl ? (
                          <img
                            src={b.coverDataUrl}
                            // Decorative: the build's name is right below it in text.
                            alt=""
                            className="w-full h-full object-cover hover-zoom"
                          />
                        ) : (
                          <div className="w-full h-full grid place-items-center text-text-3">
                            <HardDrive aria-hidden size={26} />
                          </div>
                        )}
                        <div className="absolute inset-0 bg-gradient-to-t from-bg/85 via-transparent to-transparent" />
                        {isSelected && (
                          <span className="absolute top-2.5 right-2.5">
                            <Badge tone="accent"><Check aria-hidden size={11} />Selected</Badge>
                          </span>
                        )}
                      </div>
                      <div className="px-3.5 py-3">
                        <p className="text-sm font-semibold text-text truncate">{b.name}</p>
                        <p className="text-2xs text-text-3 font-mono truncate mt-0.5 selectable" title={b.path}>
                          {b.path}
                        </p>
                      </div>
                    </button>

                    <button
                      onClick={() => api.removeBuild(b.id)}
                      aria-label={`Remove ${b.name} from your library`}
                      className="absolute top-2.5 left-2.5 size-8 grid place-items-center rounded-lg bg-bg/70 backdrop-blur text-text-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger transition-opacity duration-200 cursor-pointer"
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

      <p className="text-xs text-text-3 mt-5 leading-relaxed max-w-lg">
        Removing a build only takes it out of this list. Nothing is deleted from your disk.
      </p>
    </div>
  );
}
