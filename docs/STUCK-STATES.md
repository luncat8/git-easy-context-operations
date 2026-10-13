# "The repository is stuck: I can't push and I can't Sync"

A field guide to the states where VS Code's **Sync** button and the plain
**Push** stop working, how each one is recognized in a few seconds, and how to
get out of it. Everything here was reproduced against real repositories;
the command **Git Easy Ops: Diagnose Push / Sync Trouble...** now recognizes
these states and repairs the ones that have a safe repair.

## What the Sync button actually does

Sync is **two commands, not one**:

```
git pull            (merge, or rebase when git.pullRebase / pull.rebase is on)
git push
```

So a repository can be in a state where the *push* half is fine but the *pull*
half fails, or the pull half leaves something behind and the push half then has
nothing valid to push. That is why the symptom is "unfinished": the operation
was two steps long and the first step stopped.

## The states, and how to tell them apart

| What `git status` says | What is wrong | Why Sync cannot fix it |
|---|---|---|
| `You have uncommitted changes... ` + `Unmerged paths` + conflict markers in a file | **An unfinished merge / rebase / cherry-pick**, left by a conflict (see A) | `git pull` refuses to start: *"You have not concluded your merge (MERGE_HEAD exists)"*. `git push` is refused until the merge is committed. |
| `Your branch and 'origin/main' have diverged`, and `git cherry origin/main main` prints a `-` line | **The same work committed twice** (see B) - the reported case | A plain push is rejected as non-fast-forward; the pull half *merges* the remote copy of your own work back in |
| `Your branch and 'origin/main' have diverged` after a reword / squash / move / Clean History | **A rewritten branch the remote still has** (see C) | `git pull` merges the *old* commits back in - the rewrite is undone, or the merge conflicts and lands you in state A |
| `fatal: Unable to create '.../index.lock': File exists. Another git process seems to be running` | **A stale `index.lock`** (see D) | Nothing can write the index, so the pull half fails before it does anything |
| `Your branch is based on 'origin/main', but the upstream is gone` / `no upstream` | **The branch is not published, or the branch it tracks was deleted** (see E) | Sync has no destination: VS Code shows *"Publish Branch"* instead, or the push fails with *"no such ref"* |

Fast diagnosis:

```bash
git status -sb                      # diverged? behind? ahead? merge in progress?
git ls-files -u                      # unmerged paths (conflict)
ls .git/MERGE_HEAD .git/rebase-merge .git/rebase-apply .git/index.lock 2>/dev/null
git cherry -v origin/main main       # '-' = this change is already on the remote
```

Or run **Git Easy Ops: Diagnose Push / Sync Trouble...** - it reads exactly these
facts, says what a push would do, and offers the repair.

## A. An unfinished merge (the state that "remains unfinished")

**Reproduce it** (this is what the two-clone accident produces):

```bash
# local commit and a remote copy of the same file were both made
git pull --no-rebase origin main
# Auto-merging plan.md
# CONFLICT (content): Merge conflict in plan.md
# Automatic merge failed; fix conflicts and then commit the result.
git push origin main
# error: failed to push some refs  (and from now on git pull says:
# "You have not concluded your merge (MERGE_HEAD exists)")
```

**What is really there:** `.git/MERGE_HEAD` exists, one or more paths are
unmerged (`git ls-files -u`), and the files contain `<<<<<<<`/`>>>>>>>`
markers. The *commits* are safe; only the merge is half-done.

**Ways out** (pick one - all of them end with a working repository):

```bash
git merge --abort        # back to the commit before the pull; nothing lost
# ...or: edit the file, git add it, git commit     (finish the merge)
```

Then push. If the merge was started by Sync, the push it was followed by never
ran; the commits you wanted to publish are still local, so push again (the
diagnosis tells you whether that push is a plain one or needs
*Force Push (with lease)*).

**When it happens without you noticing:** a lost connection during Sync kills
the fetch, VS Code reloads mid-operation, or the merge conflicts while the
window is in the background. The unfinished merge is what is left behind -
the network loss is the trigger, not the state.

## B. The same work committed twice (the reported accident)

**Reproduce it** - two clones, one file, identical content:

```bash
# in clone 1 (your machine)
echo 'draft v1' > plan.md && git add . && git commit -m 'Add plan'
# in clone 2 (another session / another machine / the GitHub web UI)
echo 'draft v1' > plan.md && git add . && git commit -m 'Add plan'   # same file, same bytes
git push origin main
# a follow-up web edit on top of the remote copy, then, locally:
git fetch
git log --oneline -1 --format=%T main        # 20b0b85...
git log --oneline -1 --format=%T origin/main # 20b0b85...   <- identical tree
git push origin main
#  ! [rejected]  main -> main (non-fast-forward)
```

The trees are **byte-identical**; the commit hashes are not, because a commit
hash covers the parent, the author/committer and the timestamp as well. Git has
no fast-forward path from one to the other, so the push is refused - while the
GitHub history is already correct.

**What Sync would have done** (and why the state looks broken afterwards):

```bash
git pull --no-rebase origin main
# Auto-merging plan.md
# CONFLICT (content): Merge conflict in plan.md    <- local "add plan" vs remote "add plan + web edit"
```

With `git.pullRebase` on, git recognizes the local commit as *already applied*
and the rebase finishes cleanly ("`warning: skipped previously applied commit`")
- that is the good path. With the merge path (the default) the repository ends
up in state A: conflict markers, `MERGE_HEAD`, and no push.

**Fix** (nothing is lost either way, and all three are offered by the
diagnosis):

```bash
git rebase origin/main     # drops the already-applied commit, replays the rest
git reset --hard origin/main   # only when *every* local commit is already there
git push --force-with-lease origin main   # only when you really have unique work
```

**Prevention:**

* `git pull --rebase` before pushing, and let one place own the push - not
  "the local clone **and** another session/machine" at the same time.
* Editing a file on github.com while a clone has uncommitted or committed copies
  of it is what split the history in the reported case. Web edits are commits
  too.
* Before pushing work an agent/another machine may also have committed, run the
  diagnosis: it compares patches (`git cherry`, `patch-id`) and names the
  counterpart commit when it exists, so "my work is already there" is a fact,
  not a guess.

## C. A rewritten branch the remote still has

After **Rename Commit Message**, **Squash**, **Fast-Forward** (forced),
**Apply Patch** or **Clean History**, the local branch no longer descends from
the remote copy: the remote still holds the old commits. A plain `git push` is
rejected - that is expected, and the extension says so and offers *Force Push
(with lease)*.

The trap is doing what one always does: pressing **Sync**. Sync's pull half
merges the old history back in

```
*   Merge branch 'main' of origin
|\
| * 44e8f70  Edit plan from the web UI      <- the old copy comes back
* | 5d2c4e9  Add plan (rewritten locally)
```

which either resurrects the commits the rewrite removed (duplicate history,
dead files back) or conflicts and leaves state A. **On a rewritten branch,
Sync is the wrong button** - use *Force Push (with lease)*; it publishes the
rewrite and refuses if somebody else pushed in the meantime.

## D. A stale lock file

`git` writes `.git/index.lock` while it updates the index and deletes it when it
finishes. A process that is **killed** - a timeout, VS Code reloaded, a machine
that went to sleep mid-operation, `kill -9` - never gets to delete it, and every
later operation fails with *"Another git process seems to be running in this
repository"*. Push itself only needs refs, but VS Code's Sync does the pull
first, which does need the index.

```bash
ls -l .git/*.lock        # age is the hint: a lock from hours ago is stale
rm .git/index.lock       # only when no git/VS Code operation is running!
```

The diagnosis shows the lock with its age and removes it after an explicit
confirmation; it never removes anything automatically.

## E. A missing upstream

Two variants, both make Sync fail:

```bash
git push -u origin main            # never published: no upstream at all
git fetch --prune && git status -sb # the tracked branch was deleted/renamed on the server
```

The first is cured by publishing (`git push -u <remote> <branch>`); the second
by publishing again, by pointing the branch at its new name, or by removing the
stale configuration. The diagnosis offers the publish and the fetch.

## What network loss actually causes

The reported guess was "probably the internet connection was lost". Tested
against real repositories, a lost connection on its own is the *safe* case:

| Operation interrupted by network loss | What is left behind |
|---|---|
| `git push` fails/times out | Nothing local. The ref is unchanged here and on the server (a push updates refs atomically per ref); just push again. |
| `git fetch` fails/times out | Nothing. Remote-tracking refs stay as they were, so the local view is merely *stale*. |
| VS Code **Sync** fails in the fetch half | Nothing - the merge never starts. |
| VS Code **Sync** fails/hangs in the *merge* half, or you cancel it | State A: an unfinished merge (and sometimes a lock from a killed process). |

So a connection problem does not create divergence - it can only interrupt a
merge that was already going to happen. The *stuck* states come from the
history (B, C) or from a killed process (A, D). The diagnosis has a *Fetch the
remote and check again* step precisely so "the network is down" and "the history
diverged" are told apart instead of guessed.

## What the extension now does about it

* **Git Easy Ops: Diagnose Push / Sync Trouble...** - one command that reads the
  repository, states what a push would do (*rejected: non-fast-forward*, *it
  would work*, *blocked by an unfinished merge*, ...), explains why Sync makes
  state B worse, and offers the repairs: abort the unfinished operation, remove
  a stale lock, rebase onto the remote copy (duplicates are dropped by git
  itself), point the branch at the remote copy when nothing local is unique,
  force push with lease, fetch, publish. Every repair that touches a ref is
  journaled, so **Undo Last Operation** puts it back.
* **A guard in front of every operation that rewrites or moves refs**
  (Rename Commit Message, Squash, Fast-Forward, Force Push, Clean History,
  Remove Redundant Branches, branch rename/delete): if a merge, rebase,
  cherry-pick, revert or lock file is in the way, the operation refuses to start
  and says what to do - half-finished repositories are never built upon by
  accident. The patch flow is exempt from the `git am` it produces itself.
* **The Sync warning where it matters**: after a reword, a squash or a
  forced move that needs a force push, the report now says out loud not to use
  Sync for it, and why.

## Recovery cheat sheet

```bash
# 1. What state am I in?
git status -sb
git ls-files -u                    # unmerged paths?
ls .git/MERGE_HEAD .git/rebase-* .git/CHERRY_PICK_HEAD .git/*.lock 2>/dev/null

# 2. Unfinished operation?
git merge --abort                  # or: git rebase --abort | git cherry-pick --abort | git am --abort

# 3. Same work on both sides?
git cherry -v origin/main main     # '-' means the change is already there
git rebase origin/main             # drops those, replays your real work

# 4. Everything local already on the remote?
git fetch && git reset --hard origin/main

# 5. Unique work, rewritten history?
git push --force-with-lease origin main

# 6. Lock file left behind by a killed process?
rm .git/index.lock                 # only when nothing is running

# 7. No upstream?
git push -u origin main
```
