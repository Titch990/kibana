/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import _ from 'lodash';
import chrome from 'ui/chrome';
import 'ui/listen';
import React from 'react';
import { I18nProvider } from '@kbn/i18n/react';
import { i18n } from '@kbn/i18n';
import { capabilities } from 'ui/capabilities';
import { render, unmountComponentAtNode } from 'react-dom';
import { uiModules } from 'ui/modules';
import { timefilter } from 'ui/timefilter';
import { Provider } from 'react-redux';
import { createMapStore } from '../reducers/store';
import { GisMap } from '../connected_components/gis_map';
import { addHelpMenuToAppChrome } from '../help_menu_util';
import {
  setSelectedLayer,
  setRefreshConfig,
  setGotoWithCenter,
  replaceLayerList,
  setQuery,
  clearTransientLayerStateAndCloseFlyout,
} from '../actions/map_actions';
import { DEFAULT_IS_LAYER_TOC_OPEN, FLYOUT_STATE } from '../reducers/ui';
import {
  enableFullScreen,
  updateFlyout,
  setReadOnly,
  setIsLayerTOCOpen,
  setOpenTOCDetails,
} from '../actions/ui_actions';
import { getIsFullScreen } from '../selectors/ui_selectors';
import { copyPersistentState } from '../reducers/util';
import { getQueryableUniqueIndexPatternIds, hasDirtyState, getLayerListRaw } from '../selectors/map_selectors';
import { getInspectorAdapters } from '../reducers/non_serializable_instances';
import { Inspector } from 'ui/inspector';
import { docTitle } from 'ui/doc_title';
import { indexPatternService } from '../kibana_services';
import { SavedObjectSaveModal } from 'ui/saved_objects/components/saved_object_save_modal';
import { showSaveModal } from 'ui/saved_objects/show_saved_object_save_modal';
import { toastNotifications } from 'ui/notify';
import { getInitialLayers } from './get_initial_layers';
import { getInitialQuery } from './get_initial_query';
import { getInitialTimeFilters } from './get_initial_time_filters';
import { getInitialRefreshConfig } from './get_initial_refresh_config';
import {
  MAP_SAVED_OBJECT_TYPE,
  MAP_APP_PATH
} from '../../common/constants';

const REACT_ANCHOR_DOM_ELEMENT_ID = 'react-maps-root';


const app = uiModules.get(MAP_APP_PATH, []);

app.controller('GisMapController', ($scope, $route, config, kbnUrl, localStorage, AppState, globalState) => {

  const savedMap = $route.current.locals.map;
  let unsubscribe;
  let initialLayerListConfig;

  const store = createMapStore();

  $scope.$listen(globalState, 'fetch_with_changes', (diff) => {
    if (diff.includes('time')) {
      $scope.updateQueryAndDispatch({ query: $scope.query, dateRange: globalState.time });
    }
    if (diff.includes('refreshInterval')) {
      $scope.onRefreshChange({ isPaused: globalState.pause, refreshInterval: globalState.value });
    }
  });

  const $state = new AppState();
  $scope.$listen($state, 'fetch_with_changes', function (diff) {
    if (diff.includes('query') && $state.query) {
      $scope.updateQueryAndDispatch({ query: $state.query, dateRange: $scope.time });
    }
  });

  function syncAppAndGlobalState() {
    $scope.$evalAsync(() => {
      $state.query = $scope.query;
      $state.save();
      globalState.time = $scope.time;
      globalState.refreshInterval = {
        pause: $scope.refreshConfig.isPaused,
        value: $scope.refreshConfig.interval,
      };
      globalState.save();
    });
  }

  $scope.query = getInitialQuery({
    mapStateJSON: savedMap.mapStateJSON,
    appState: $state,
    userQueryLanguage: localStorage.get('kibana.userQueryLanguage')
  });
  $scope.time = getInitialTimeFilters({
    mapStateJSON: savedMap.mapStateJSON,
    globalState: globalState,
  });
  $scope.refreshConfig = getInitialRefreshConfig({
    mapStateJSON: savedMap.mapStateJSON,
    globalState: globalState,
  });
  syncAppAndGlobalState();

  $scope.indexPatterns = [];
  $scope.updateQueryAndDispatch = function ({ dateRange, query }) {
    $scope.query = query;
    $scope.time = dateRange;
    syncAppAndGlobalState();

    store.dispatch(setQuery({ query: $scope.query, timeFilters: $scope.time }));
  };
  $scope.onRefreshChange = function ({ isPaused, refreshInterval }) {
    $scope.refreshConfig = {
      isPaused,
      interval: refreshInterval ? refreshInterval : $scope.refreshConfig.interval
    };
    syncAppAndGlobalState();

    store.dispatch(setRefreshConfig($scope.refreshConfig));
  };


  function hasUnsavedChanges() {

    const state = store.getState();
    const layerList = getLayerListRaw(state);
    const layerListConfigOnly = copyPersistentState(layerList);

    const savedLayerList  = savedMap.getLayerList();
    const oldConfig = savedLayerList ? savedLayerList : initialLayerListConfig;

    return !_.isEqual(layerListConfigOnly, oldConfig);
  }

  function isOnMapNow() {
    return window.location.hash.startsWith(`#/${MAP_SAVED_OBJECT_TYPE}`);
  }

  function beforeUnload(event) {
    if (!isOnMapNow()) {
      return;
    }

    const hasChanged = hasUnsavedChanges();
    if (hasChanged) {
      event.preventDefault();
      event.returnValue = 'foobar';//this is required for Chrome
    }
  }
  window.addEventListener('beforeunload', beforeUnload);

  function renderMap() {
    // clear old UI state
    store.dispatch(setSelectedLayer(null));
    store.dispatch(updateFlyout(FLYOUT_STATE.NONE));
    store.dispatch(setReadOnly(!capabilities.get().maps.save));

    handleStoreChanges(store);
    unsubscribe = store.subscribe(() => {
      handleStoreChanges(store);
    });

    // sync store with savedMap mapState
    if (savedMap.mapStateJSON) {
      const mapState = JSON.parse(savedMap.mapStateJSON);
      store.dispatch(setGotoWithCenter({
        lat: mapState.center.lat,
        lon: mapState.center.lon,
        zoom: mapState.zoom,
      }));
    }

    if (savedMap.uiStateJSON) {
      const uiState = JSON.parse(savedMap.uiStateJSON);
      store.dispatch(setIsLayerTOCOpen(_.get(uiState, 'isLayerTOCOpen', DEFAULT_IS_LAYER_TOC_OPEN)));
      store.dispatch(setOpenTOCDetails(_.get(uiState, 'openTOCDetails', [])));
    }

    const isDarkMode = config.get('theme:darkMode', false);
    const layerList = getInitialLayers(savedMap.layerListJSON, isDarkMode);
    initialLayerListConfig = copyPersistentState(layerList);
    store.dispatch(replaceLayerList(layerList));
    store.dispatch(setRefreshConfig($scope.refreshConfig));
    store.dispatch(setQuery({ query: $scope.query, timeFilters: $scope.time }));

    const root = document.getElementById(REACT_ANCHOR_DOM_ELEMENT_ID);
    render(
      <Provider store={store}>
        <I18nProvider>
          <GisMap/>
        </I18nProvider>
      </Provider>,
      root
    );
  }
  renderMap();

  let prevIndexPatternIds;
  async function updateIndexPatterns(nextIndexPatternIds) {
    const indexPatterns = [];
    const getIndexPatternPromises = nextIndexPatternIds.map(async (indexPatternId) => {
      try {
        const indexPattern = await indexPatternService.get(indexPatternId);
        indexPatterns.push(indexPattern);
      } catch(err) {
        // unable to fetch index pattern
      }
    });

    await Promise.all(getIndexPatternPromises);
    // ignore outdated results
    if (prevIndexPatternIds !== nextIndexPatternIds) {
      return;
    }
    $scope.indexPatterns = indexPatterns;
  }

  $scope.isFullScreen = false;
  $scope.isSaveDisabled = false;
  function handleStoreChanges(store) {
    const nextIsFullScreen = getIsFullScreen(store.getState());
    if (nextIsFullScreen !== $scope.isFullScreen) {
      // Must trigger digest cycle for angular top nav to redraw itself when isFullScreen changes
      $scope.$evalAsync(() => {
        $scope.isFullScreen = nextIsFullScreen;
      });
    }

    const nextIndexPatternIds = getQueryableUniqueIndexPatternIds(store.getState());
    if (nextIndexPatternIds !== prevIndexPatternIds) {
      prevIndexPatternIds = nextIndexPatternIds;
      updateIndexPatterns(nextIndexPatternIds);
    }

    const nextIsSaveDisabled = hasDirtyState(store.getState());
    if (nextIsSaveDisabled !== $scope.isSaveDisabled) {
      $scope.$evalAsync(() => {
        $scope.isSaveDisabled = nextIsSaveDisabled;
      });
    }
  }

  $scope.$on('$destroy', () => {

    window.removeEventListener('beforeunload', beforeUnload);

    if (unsubscribe) {
      unsubscribe();
    }
    const node = document.getElementById(REACT_ANCHOR_DOM_ELEMENT_ID);
    if (node) {
      unmountComponentAtNode(node);
    }
  });

  const updateBreadcrumbs = () => {
    chrome.breadcrumbs.set([
      {
        text: i18n.translate('xpack.maps.mapController.mapsBreadcrumbLabel', {
          defaultMessage: 'Maps'
        }),
        onClick: () => {
          if (isOnMapNow() && hasUnsavedChanges()) {
            const navigateAway = window.confirm(i18n.translate('xpack.maps.mapController.unsavedChangesWarning', {
              defaultMessage: `Your unsaved changes might not be saved`,
            }));
            if (navigateAway) {
              window.location.hash = '#';
            }
          } else {
            window.location.hash = '#';
          }
        }
      },
      { text: savedMap.title }
    ]);
  };
  updateBreadcrumbs();

  addHelpMenuToAppChrome(chrome);

  async function doSave(saveOptions) {
    await store.dispatch(clearTransientLayerStateAndCloseFlyout());
    savedMap.syncWithStore(store.getState());
    let id;

    try {
      id = await savedMap.save(saveOptions);
      docTitle.change(savedMap.title);
    } catch(err) {
      toastNotifications.addDanger({
        title: i18n.translate('xpack.maps.mapController.saveErrorMessage', {
          defaultMessage: `Error on saving '{title}'`,
          values: { title: savedMap.title }
        }),
        text: err.message,
        'data-test-subj': 'saveMapError',
      });
      return { error: err };
    }

    if (id) {
      toastNotifications.addSuccess({
        title: i18n.translate('xpack.maps.mapController.saveSuccessMessage', {
          defaultMessage: `Saved '{title}'`,
          values: { title: savedMap.title }
        }),
        'data-test-subj': 'saveMapSuccess',
      });

      updateBreadcrumbs();

      if (savedMap.id !== $route.current.params.id) {
        $scope.$evalAsync(() => {
          kbnUrl.change(`map/{{id}}`, { id: savedMap.id });
        });
      }
    }
    return { id };
  }

  // Hide angular timepicer/refresh UI from top nav
  timefilter.disableTimeRangeSelector();
  timefilter.disableAutoRefreshSelector();
  $scope.showDatePicker = true; // used by query-bar directive to enable timepikcer in query bar
  $scope.topNavMenu = [{
    key: i18n.translate('xpack.maps.mapController.fullScreenButtonLabel', {
      defaultMessage: `full screen`
    }),
    description: i18n.translate('xpack.maps.mapController.fullScreenDescription', {
      defaultMessage: `full screen`
    }),
    testId: 'mapsFullScreenMode',
    run() {
      store.dispatch(enableFullScreen());
    }
  }, {
    key: i18n.translate('xpack.maps.mapController.openInspectorButtonLabel', {
      defaultMessage: `inspect`
    }),
    description: i18n.translate('xpack.maps.mapController.openInspectorDescription', {
      defaultMessage: `Open Inspector`
    }),
    testId: 'openInspectorButton',
    run() {
      const inspectorAdapters = getInspectorAdapters(store.getState());
      Inspector.open(inspectorAdapters, {});
    }
  }, ...(capabilities.get().maps.save ? [{
    key: i18n.translate('xpack.maps.mapController.saveMapButtonLabel', {
      defaultMessage: `save`
    }),
    description: i18n.translate('xpack.maps.mapController.saveMapDescription', {
      defaultMessage: `Save map`
    }),
    testId: 'mapSaveButton',
    disableButton() {
      return $scope.isSaveDisabled;
    },
    tooltip() {
      if ($scope.isSaveDisabled) {
        return i18n.translate('xpack.maps.mapController.saveMapDisabledButtonTooltip', {
          defaultMessage: 'Save or Cancel your layer changes before saving'
        });
      }
    },
    run: async () => {
      const onSave = ({ newTitle, newCopyOnSave, isTitleDuplicateConfirmed, onTitleDuplicate }) => {
        const currentTitle = savedMap.title;
        savedMap.title = newTitle;
        savedMap.copyOnSave = newCopyOnSave;
        const saveOptions = {
          confirmOverwrite: false,
          isTitleDuplicateConfirmed,
          onTitleDuplicate,
        };
        return doSave(saveOptions).then(({ id, error }) => {
          // If the save wasn't successful, put the original values back.
          if (!id || error) {
            savedMap.title = currentTitle;
          }
          return { id, error };
        });
      };

      const saveModal = (
        <SavedObjectSaveModal
          onSave={onSave}
          onClose={() => {}}
          title={savedMap.title}
          showCopyOnSave={savedMap.id ? true : false}
          objectType={MAP_SAVED_OBJECT_TYPE}
        />);
      showSaveModal(saveModal);
    }
  }] : [])
  ];
});

