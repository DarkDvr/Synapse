# Synapse v1.2.0

The projects folder is now the registry's source, not just its home.

## New

Any folder already in `..\Synapse.Projects` is adopted as a project at start-up.
A project **is** a directory, so a folder the operator copied in is a project
already; it only lacked a registry entry, and waiting for Add Project left the
folder and the rail disagreeing.

A discovered project gets what Add Project gives one:

- `.synapse\plan.json`, with the empty valid plan, only when the file is missing;
- the scratch folder its brief names, under `_scratch`.

An existing name, created stamp and plan are kept. Discovery is idempotent: a
registered folder is not added twice, and a second start finds nothing new.

## Not projects

A leading underscore is the harness's namespace: `_scratch` and `_probe` are the
two it uses today, and the whole prefix is reserved so a folder it adds later
cannot turn into a project. Dot folders, `$` folders and drive metadata are
skipped too. A junction back to the harness — or to a folder that contains it — is
refused and logged, because that is not a folder a model should be handed.

## Also

`Add Project` and discovery now go through one helper, so both create the same
two things. The boot line says how many folders were found:

```
projects: 4 (2 found in the folder)
```

## Notes

- Full suite: 257 tests.
- One asset: `Synapse-1.2.0-win-x64.zip` with `SHA256SUMS`.
