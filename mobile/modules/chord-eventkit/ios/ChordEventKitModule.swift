import EventKit
import ExpoModulesCore

// ADR 0057 — expose EventKit's calendarItemExternalIdentifier, which
// expo-calendar omits. Used as the Layer-0 dedup key for the device-calendar
// read-up so a Google event mirrored onto the device collapses onto the copy
// the server already pulled via the Google API.
public class ChordEventKitModule: Module {
  private let store = EKEventStore()

  public func definition() -> ModuleDefinition {
    Name("ChordEventKit")

    AsyncFunction("externalIdsForEvents") { (eventIds: [String]) -> [String: String] in
      var out: [String: String] = [:]
      for id in eventIds {
        // event(withIdentifier:) takes the EKEvent.eventIdentifier, which is
        // exactly what expo-calendar returns as the event `id`.
        if let event = self.store.event(withIdentifier: id),
           let externalId = event.calendarItemExternalIdentifier {
          out[id] = externalId
        }
      }
      return out
    }
  }
}
