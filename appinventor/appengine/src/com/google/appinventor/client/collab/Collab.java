// -*- mode: java; c-basic-offset: 2; -*-
// Released under the Apache License, Version 2.0
// http://www.apache.org/licenses/LICENSE-2.0

package com.google.appinventor.client.collab;

import com.google.appinventor.client.Ode;
import com.google.appinventor.client.editor.EditorManager;
import com.google.appinventor.client.editor.FileEditor;
import com.google.appinventor.client.editor.ProjectEditor;
import com.google.appinventor.client.editor.blocks.BlocksEditor;
import com.google.appinventor.client.editor.simple.components.MockComponent;
import com.google.appinventor.client.editor.simple.components.MockContainer;
import com.google.appinventor.client.editor.simple.components.MockForm;
import com.google.appinventor.client.editor.youngandroid.YaBlocksEditor;
import com.google.appinventor.client.editor.youngandroid.YaFormEditor;
import com.google.appinventor.client.editor.youngandroid.YaProjectEditor;
import com.google.appinventor.client.explorer.project.Project;
import com.google.appinventor.shared.rpc.project.youngandroid.YoungAndroidSourceNode;
import com.google.gwt.core.client.JavaScriptObject;
import com.google.gwt.core.client.Scheduler;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Java side of real-time collaboration. The browser script static/js/collab.js owns the
 * connection to the collaboration hub and the Blockly side; this class turns designer changes into
 * small ops, applies ops from teammates to the designer, and stops non-main clients from saving.
 *
 * Designer ops identify components by their Uuid property:
 *   prop    {uuid, a: property name, b: value}
 *   rename  {uuid, a: new name}
 *   remove  {uuid}
 *   addmove {uuid, a: parent uuid, b: component JSON (with children), c: all properties, index}
 */
public final class Collab {
  private static final Logger LOG = Logger.getLogger(Collab.class.getName());

  private static boolean applying = false;
  private static final Set<Long> followerProjects = new HashSet<>();
  private static final Map<YaFormEditor, Set<MockComponent>> pendingStructure = new HashMap<>();

  private Collab() {
  }

  public static void init() {
    exportMethods();
  }

  /** True while a teammate's change is being applied; local listeners must not echo it. */
  public static boolean isApplyingRemote() {
    return applying;
  }

  /**
   * Only the main client of a shared project writes its files, so that teammates never overwrite
   * each other. Everyone else's edits reach the server through the main client.
   */
  public static boolean mayAutoSave(long projectId) {
    return !followerProjects.contains(projectId);
  }

  // Outgoing designer changes (called from YaFormEditor's DesignerChangeListener methods)

  public static void propertyChanged(YaFormEditor editor, MockComponent component, String name,
      String value) {
    if (!shouldSend(editor) || MockComponent.PROPERTY_NAME_NAME.equals(name)
        || MockComponent.PROPERTY_NAME_UUID.equals(name) || !component.isPropertyPersisted(name)
        || isPending(editor, component)) {
      return;
    }
    send(editor, "prop", component.getUuid(), name, value, null, 0);
  }

  public static void componentRenamed(YaFormEditor editor, MockComponent component) {
    if (!shouldSend(editor) || isPending(editor, component)) {
      return;
    }
    send(editor, "rename", component.getUuid(), component.getName(), null, null, 0);
  }

  public static void componentAdded(YaFormEditor editor, MockComponent component) {
    if (shouldSend(editor)) {
      queueStructure(editor, component);
    }
  }

  public static void componentRemoved(YaFormEditor editor, MockComponent component,
      boolean permanentlyDeleted) {
    if (!shouldSend(editor)) {
      return;
    }
    if (permanentlyDeleted) {
      Set<MockComponent> pending = pendingStructure.get(editor);
      if (pending != null) {
        pending.remove(component);
      }
      send(editor, "remove", component.getUuid(), null, null, null, 0);
    } else {
      queueStructure(editor, component);  // a move: the matching add follows in this event loop
    }
  }

  // Structural changes are sent once the current event finishes, when the new component has its
  // final name and properties and a moved component is in its new container.
  private static void queueStructure(final YaFormEditor editor, MockComponent component) {
    Set<MockComponent> pending = pendingStructure.get(editor);
    if (pending == null) {
      pending = new LinkedHashSet<>();
      pendingStructure.put(editor, pending);
      Scheduler.get().scheduleDeferred(() -> flushStructure(editor));
    }
    pending.add(component);
  }

  private static void flushStructure(YaFormEditor editor) {
    Set<MockComponent> pending = pendingStructure.remove(editor);
    if (pending == null) {
      return;
    }
    for (MockComponent component : pending) {
      MockContainer parent = component.getContainer();
      if (parent == null || !isAttached(editor.getForm(), component)
          || hasPendingAncestor(pending, component)) {
        continue;
      }
      send(editor, "addmove", component.getUuid(), parent.getUuid(),
          editor.encodeComponentForCollab(component),
          component.getProperties().encodeAllAsJsonString(),
          parent.getChildren().indexOf(component));
    }
  }

  private static boolean isPending(YaFormEditor editor, MockComponent component) {
    Set<MockComponent> pending = pendingStructure.get(editor);
    if (pending == null) {
      return false;
    }
    for (MockComponent c = component; c != null; c = c.getContainer()) {
      if (pending.contains(c)) {
        return true;
      }
    }
    return false;
  }

  private static boolean hasPendingAncestor(Set<MockComponent> pending, MockComponent component) {
    for (MockComponent c = component.getContainer(); c != null; c = c.getContainer()) {
      if (pending.contains(c)) {
        return true;
      }
    }
    return false;
  }

  private static boolean isAttached(MockForm form, MockComponent component) {
    MockComponent c = component;
    while (c != form) {
      MockContainer parent = c.getContainer();
      if (parent == null || !parent.getChildren().contains(c)) {
        return false;
      }
      c = parent;
    }
    return true;
  }

  private static boolean shouldSend(YaFormEditor editor) {
    return !applying && editor.isLoadComplete()
        && isJoined(String.valueOf(editor.getProjectId()));
  }

  private static void send(YaFormEditor editor, String op, String uuid, String a, String b,
      String c, int index) {
    sendOp(String.valueOf(editor.getProjectId()), editor.getEntityName(), op, uuid, a, b, c,
        index);
  }

  // Incoming changes (called from collab.js)

  /**
   * Applies a teammate's designer op.
   *
   * @return "ok" when applied (or no longer applicable), "wait" when the screen is still loading
   */
  private static String applyDesignerOp(String projectId, String screen, String op, String uuid,
      String a, String b, String c, int index) {
    YaFormEditor editor = formEditor(projectId, screen);
    if (editor == null || !isScreenReady(projectId, screen)) {
      return "wait";
    }
    MockForm form = editor.getForm();
    applying = true;
    setJsApplying(true);
    try {
      MockComponent component = find(form, uuid);
      switch (op) {
        case "prop":
          if (component != null && !b.equals(component.getPropertyValue(a))) {
            component.changeProperty(a, b);
          }
          break;
        case "rename":
          if (component != null && component != form && !a.equals(component.getName())) {
            component.rename(a);
          }
          break;
        case "remove":
          if (component != null && component != form) {
            removeKeepingSelection(form, component);
          }
          break;
        case "addmove": {
          MockComponent parent = find(form, a);
          if (!(parent instanceof MockContainer)) {
            break;
          }
          if (component == null) {
            component = editor.createComponentForCollab(b, (MockContainer) parent);
          } else {
            editor.applyCollabProperties(component, c);
          }
          place((MockContainer) parent, component, index);
          break;
        }
        default:
          break;
      }
      return "ok";
    } catch (RuntimeException e) {
      LOG.log(Level.WARNING, "Could not apply teammate's designer change " + op, e);
      return "ok";
    } finally {
      applying = false;
      setJsApplying(false);
    }
  }

  private static void place(MockContainer parent, MockComponent component, int index) {
    if (!component.isVisibleComponent()) {
      return;  // non-visible components live on the form and have no position
    }
    MockContainer current = component.getContainer();
    if (current == parent && parent.getChildren().indexOf(component) == index) {
      return;
    }
    current.removeComponent(component, false);
    int size = parent.getChildren().size();
    parent.addComponent(component, index < 0 || index > size ? size : index);
  }

  private static void removeKeepingSelection(MockForm form, MockComponent component) {
    List<MockComponent> selected = new ArrayList<>(form.getSelectedComponents());
    component.delete();
    for (MockComponent s : selected) {
      if (s != component && isAttached(form, s)) {
        s.select(null);
        break;
      }
    }
  }

  private static MockComponent find(MockComponent root, String uuid) {
    if (uuid == null) {
      return null;
    }
    if (uuid.equals(root.getUuid())) {
      return root;
    }
    for (MockComponent child : root.getChildren()) {
      MockComponent found = find(child, uuid);
      if (found != null) {
        return found;
      }
    }
    return null;
  }

  private static YaProjectEditor projectEditor(String projectId) {
    ProjectEditor editor;
    try {
      editor = Ode.getInstance().getEditorManager().getOpenProjectEditor(Long.parseLong(projectId));
    } catch (NumberFormatException e) {
      return null;
    }
    return editor instanceof YaProjectEditor ? (YaProjectEditor) editor : null;
  }

  private static YaFormEditor formEditor(String projectId, String screen) {
    YaProjectEditor editor = projectEditor(projectId);
    if (editor == null || !(editor.getFormFileEditor(screen) instanceof YaFormEditor)) {
      return null;
    }
    return (YaFormEditor) editor.getFormFileEditor(screen);
  }

  private static boolean isScreenReady(String projectId, String screen) {
    YaProjectEditor editor = projectEditor(projectId);
    if (editor == null) {
      return false;
    }
    YaFormEditor form = formEditor(projectId, screen);
    BlocksEditor<?, ?> blocks = editor.getBlocksFileEditor(screen);
    return form != null && blocks != null && form.isLoadComplete() && blocks.isLoadComplete();
  }

  /**
   * Called by collab.js when the hub says who the main client of the project is.
   */
  private static void setMain(String projectId, boolean main) {
    long id;
    try {
      id = Long.parseLong(projectId);
    } catch (NumberFormatException e) {
      return;
    }
    if (main) {
      if (followerProjects.remove(id)) {
        // Taking over as main: save what teammates did while someone else was saving.
        ProjectEditor editor = Ode.getInstance().getEditorManager().getOpenProjectEditor(id);
        if (editor != null) {
          EditorManager manager = Ode.getInstance().getEditorManager();
          for (FileEditor fileEditor : editor.getOpenFileEditors()) {
            manager.scheduleAutoSave(fileEditor);
          }
        }
      }
    } else {
      followerProjects.add(id);
    }
  }

  /**
   * Describes where this user is, for the presence list: project, screen and editor.
   */
  private static String getContext() {
    Ode ode = Ode.getInstance();
    FileEditor editor = ode.getCurrentFileEditor();
    if (ode.getCurrentView() != Ode.DESIGNER || editor == null
        || !(editor.getFileNode() instanceof YoungAndroidSourceNode)) {
      return "";
    }
    long projectId = editor.getProjectId();
    Project project = ode.getProjectManager().getProject(projectId);
    return projectId + "\n" + (project == null ? "" : project.getProjectName()) + "\n"
        + ((YoungAndroidSourceNode) editor.getFileNode()).getFormName() + "\n"
        + (editor instanceof YaBlocksEditor ? "blocks" : "designer");
  }

  /** True if the Blockly event was produced while applying a teammate's change. */
  public static native boolean isRemoteEvent(JavaScriptObject event)/*-{
    return !!(event && typeof event.group === 'string' && event.group.indexOf('collab:') === 0);
  }-*/;

  private static native void setJsApplying(boolean value)/*-{
    $wnd.AICollab_applying = value;
  }-*/;

  private static native boolean isJoined(String projectId)/*-{
    return !!($wnd.AICollab && $wnd.AICollab.isJoined(projectId));
  }-*/;

  private static native void sendOp(String projectId, String screen, String op, String uuid,
      String a, String b, String c, int index)/*-{
    if ($wnd.AICollab) {
      $wnd.AICollab.sendDesignerOp(projectId, screen,
        {op: op, uuid: uuid, a: a, b: b, c: c, index: index});
    }
  }-*/;

  private static native void exportMethods()/*-{
    $wnd.AICollab_applyDesignerOp = $entry(@com.google.appinventor.client.collab.Collab::applyDesignerOp(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;I));
    $wnd.AICollab_isScreenReady = $entry(@com.google.appinventor.client.collab.Collab::isScreenReady(Ljava/lang/String;Ljava/lang/String;));
    $wnd.AICollab_setMain = $entry(@com.google.appinventor.client.collab.Collab::setMain(Ljava/lang/String;Z));
    $wnd.AICollab_getContext = $entry(@com.google.appinventor.client.collab.Collab::getContext());
    if ($wnd.AICollab && $wnd.AICollab.bridgeReady) {
      $wnd.AICollab.bridgeReady();
    }
  }-*/;
}
