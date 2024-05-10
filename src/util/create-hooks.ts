import {
  filter,
  flatten,
  flow,
  groupBy,
  isEmpty,
  mapValues,
  partition,
} from "lodash/fp";
import { App, Keymap } from "obsidian";
import { derived, readable, writable, Writable } from "svelte/store";

import { icalRefreshIntervalMillis, reQueryAfterMillis } from "../constants";
import { currentTime } from "../global-store/current-time";
import { DataviewFacade } from "../service/dataview-facade";
import { ObsidianFacade } from "../service/obsidian-facade";
import { PlanEditor } from "../service/plan-editor";
import { DayPlannerSettings } from "../settings";
import { Task, UnscheduledTask } from "../types";
import { useDataviewChange } from "../ui/hooks/use-dataview-change";
import { useDataviewLoaded } from "../ui/hooks/use-dataview-loaded";
import { useDataviewTasks } from "../ui/hooks/use-dataview-tasks";
import { useDateRanges } from "../ui/hooks/use-date-ranges";
import { useDebounceWithDelay } from "../ui/hooks/use-debounce-with-delay";
import { useEditContext } from "../ui/hooks/use-edit/use-edit-context";
import { useIsOnline } from "../ui/hooks/use-is-online";
import { useKeyDown } from "../ui/hooks/use-key-down";
import { useListsFromVisibleDailyNotes } from "../ui/hooks/use-lists-from-visible-daily-notes";
import { useModPressed } from "../ui/hooks/use-mod-pressed";
import { useNewlyStartedTasks } from "../ui/hooks/use-newly-started-tasks";
import { useTasksFromExtraSources } from "../ui/hooks/use-tasks-from-extra-sources";
import { useVisibleDailyNotes } from "../ui/hooks/use-visible-daily-notes";
import { useVisibleDataviewTasks } from "../ui/hooks/use-visible-dataview-tasks";
import { useVisibleDays } from "../ui/hooks/use-visible-days";

import { canHappenAfter, icalEventToTasks } from "./ical";
import { getEarliestMoment } from "./moment";
import { createBackgroundBatchScheduler } from "./scheduler";
import { getUpdateTrigger } from "./store";
import { getDayKey, getEmptyRecordsForDay, mergeTasks } from "./tasks-utils";
import { useIcalEvents } from "./use-ical-events";
import { store } from "../store";
import {
  darkModeUpdated,
  dataviewChange as dataviewChangeAction,
  icalRefreshRequested,
  keyDown as keyDownAction,
  layoutReady as layoutReadyAction,
  modDown,
  modUp,
  offline,
  online,
} from "../obsidianSlice";
import DayPlanner from "../main";

interface CreateHooksProps {
  app: App;
  dataviewFacade: DataviewFacade;
  obsidianFacade: ObsidianFacade;
  settingsStore: Writable<DayPlannerSettings>;
  planEditor: PlanEditor;
  plugin: DayPlanner;
}

function getDarkModeFlag() {
  return document.body.hasClass("theme-dark");
}

export function createHooks({
  plugin,
  app,
  dataviewFacade,
  obsidianFacade,
  settingsStore,
  planEditor,
}: CreateHooksProps) {
  const dataviewSource = derived(settingsStore, ($settings) => {
    return $settings.dataviewSource;
  });
  const layoutReady = readable(false, (set) => {
    app.workspace.onLayoutReady(() => set(true));
  });
  // todo: unsub
  app.workspace.onLayoutReady(() => store.dispatch(layoutReadyAction()));

  const isDarkMode = readable(getDarkModeFlag(), (set) => {
    const eventRef = app.workspace.on("css-change", () => {
      set(getDarkModeFlag());
    });

    return () => {
      app.workspace.offref(eventRef);
    };
  });

  // todo: unsub
  app.workspace.on("css-change", () => {
    store.dispatch(darkModeUpdated(getDarkModeFlag()));
  });

  // todo: these can be global stores
  const keyDown = useKeyDown();

  // todo: unsub
  const trigger = (event: KeyboardEvent) => store.dispatch(keyDownAction());
  document.addEventListener("keydown", trigger);

  const isModPressed = useModPressed();

  plugin.registerDomEvent(document, "keydown", (event: KeyboardEvent) => {
    if (Keymap.isModifier(event, "Mod")) {
      store.dispatch(modDown());
    }
  });

  plugin.registerDomEvent(document, "keyup", (event: KeyboardEvent) => {
    if (!Keymap.isModifier(event, "Mod")) {
      store.dispatch(modUp());
    }
  });

  const isOnline = useIsOnline();

  plugin.registerDomEvent(window, "online", () => store.dispatch(online()));
  plugin.registerDomEvent(window, "offline", () => store.dispatch(offline()));

  // ---

  const dataviewChange = useDataviewChange(app.metadataCache);

  plugin.registerEvent(
    app.metadataCache.on(
      // @ts-expect-error
      "dataview:metadata-change",
      () => store.dispatch(dataviewChangeAction()),
    ),
  );

  const dataviewLoaded = useDataviewLoaded(app);

  const icalRefreshTimer = readable(getUpdateTrigger(), (set) => {
    const interval = setInterval(() => {
      set(getUpdateTrigger());
    }, icalRefreshIntervalMillis);

    return () => {
      clearInterval(interval);
    };
  });

  plugin.registerInterval(
    window.setInterval(() => {
      store.dispatch(icalRefreshRequested());
    }, icalRefreshIntervalMillis),
  );

  // ---

  const icalSyncTrigger = writable();
  const combinedIcalSyncTrigger = derived(
    [icalRefreshTimer, icalSyncTrigger],
    getUpdateTrigger,
  );

  const icalEvents = useIcalEvents(
    settingsStore,
    combinedIcalSyncTrigger,
    isOnline,
  );

  const dateRanges = useDateRanges();
  const visibleDays = useVisibleDays(dateRanges.ranges);

  // todo: improve naming
  const schedulerQueue = derived(
    [icalEvents, visibleDays],
    ([$icalEvents, $visibleDays]) => {
      if (isEmpty($icalEvents) || isEmpty($visibleDays)) {
        return [];
      }

      const earliestDay = getEarliestMoment($visibleDays);
      const startOfEarliestDay = earliestDay.clone().startOf("day").toDate();
      const relevantIcalEvents = $icalEvents.filter((icalEvent) =>
        canHappenAfter(icalEvent, startOfEarliestDay),
      );

      // todo: make it easier to understand
      return relevantIcalEvents.flatMap((icalEvent) => {
        return $visibleDays.map(
          (day) => () => icalEventToTasks(icalEvent, day),
        );
      });
    },
  );

  const tasksFromEvents = readable<Array<ReturnType<typeof icalEventToTasks>>>(
    [],
    (set) => {
      const scheduler =
        createBackgroundBatchScheduler<ReturnType<typeof icalEventToTasks>>(
          set,
        );

      return schedulerQueue.subscribe(scheduler.enqueueTasks);
    },
  );

  const visibleDayToEventOccurences = derived(
    tasksFromEvents,
    // todo: move out
    flow(
      filter(Boolean),
      flatten,
      groupBy((task: Task) => getDayKey(task.startTime)),
      mapValues((tasks) => {
        const [withTime, noTime]: [Task[], UnscheduledTask[]] = partition(
          (task) => task.startMinutes !== undefined,
          tasks,
        );

        return { withTime, noTime };
      }),
    ),
  );

  const taskUpdateTrigger = derived(
    [dataviewChange, dataviewSource],
    getUpdateTrigger,
  );
  const debouncedTaskUpdateTrigger = useDebounceWithDelay(
    taskUpdateTrigger,
    keyDown,
    reQueryAfterMillis,
  );
  const visibleDailyNotes = useVisibleDailyNotes(
    layoutReady,
    debouncedTaskUpdateTrigger,
    visibleDays,
  );
  const listsFromVisibleDailyNotes = useListsFromVisibleDailyNotes(
    visibleDailyNotes,
    debouncedTaskUpdateTrigger,
    dataviewFacade,
  );
  const tasksFromExtraSources = useTasksFromExtraSources({
    dataviewSource,
    debouncedTaskUpdateTrigger,
    visibleDailyNotes,
    dataviewFacade,
  });
  const dataviewTasks = useDataviewTasks({
    listsFromVisibleDailyNotes,
    tasksFromExtraSources,
    settingsStore,
  });
  const visibleDataviewTasks = useVisibleDataviewTasks(
    dataviewTasks,
    visibleDays,
  );

  const visibleTasks = derived(
    [visibleDataviewTasks, visibleDayToEventOccurences],
    ([$visibleDataviewTasks, $visibleDayToEventOccurences]) =>
      mergeTasks($visibleDataviewTasks, $visibleDayToEventOccurences),
  );

  const tasksForToday = derived(
    [visibleTasks, currentTime],
    ([$visibleTasks, $currentTime]) => {
      return $visibleTasks[getDayKey($currentTime)] || getEmptyRecordsForDay();
    },
  );

  const editContext = useEditContext({
    obsidianFacade,
    onUpdate: planEditor.syncTasksWithFile,
    settings: settingsStore,
    visibleTasks,
  });

  const newlyStartedTasks = useNewlyStartedTasks({
    settings: settingsStore,
    tasksForToday,
    currentTime,
  });

  return {
    editContext,
    tasksForToday,
    visibleTasks,
    dataviewLoaded,
    newlyStartedTasks,
    isModPressed,
    icalSyncTrigger,
    isOnline,
    isDarkMode,
    dateRanges,
  };
}
