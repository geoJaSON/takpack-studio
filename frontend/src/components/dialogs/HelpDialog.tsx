interface HelpDialogProps {
  onClose: () => void;
}

/**
 * Static usage guide. Offline-first reference so a new operator can build and
 * load a package without leaving the app.
 */
export default function HelpDialog({ onClose }: HelpDialogProps) {
  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true">
        <div
          className="dialog-header"
          style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
        >
          <span>HELP &amp; INSTRUCTIONS</span>
          <button type="button" className="btn btn-ghost" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="dialog-body">
          <div className="panel-section">
            <div className="label">WHAT THIS IS</div>
            <p className="help-text">
              TAKPack Studio builds offline ATAK data packages — basemap imagery,
              map markers and graphics, elevation, and a comms/PACE/MEDEVAC brief —
              that you sideload onto an ATAK device. Everything runs locally; no
              account or connection is required to plan.
            </p>
          </div>

          <div className="panel-section">
            <div className="label">1 · SET THE AREA (AOI)</div>
            <p className="help-text">
              Pick the <strong>AOI</strong> tool and drag a box over your area, or
              type an MGRS / lat, lon in the header and press <strong>GO</strong>.
              The AOI bounds the imagery and elevation that get packaged.
            </p>
          </div>

          <div className="panel-section">
            <div className="label">2 · DRAW THE MAP</div>
            <p className="help-text">
              Use the toolbar to drop markers, labels, lines, routes, polygons,
              rectangles, and circles. Select any feature to edit its name, color,
              and remarks in the right panel. Extras there:
            </p>
            <ul className="help-list">
              <li>
                <strong>Note-icon markers</strong> carry a glyph (flag, medical,
                vehicle…) that shows on the native ATAK marker via a bundled iconset.
              </li>
              <li>
                <strong>Photos / PDFs</strong> can be pinned to a marker — they ride
                into ATAK as that marker's attachments.
              </li>
              <li>
                A 2-point line can be flagged <strong>Range &amp; Bearing</strong> to
                export as a native ATAK R&amp;B arrow with a live range/bearing readout.
              </li>
            </ul>
            <p className="help-text">
              Already have data? <strong>Import</strong> KML, KMZ, GPX, GeoJSON, or a
              CSV of coordinates from the feature panel.
            </p>
          </div>

          <div className="panel-section">
            <div className="label">3 · COMMS &amp; BRIEF</div>
            <p className="help-text">
              Fill in comm nets, the PACE plan, identity, and a MEDEVAC 9-line. These
              export as readable cards, an optional ATAK <code>config.pref</code>, and
              an optional CASEVAC marker.
            </p>
          </div>

          <div className="panel-section">
            <div className="label">4 · EXPORT THE PACKAGE</div>
            <p className="help-text">
              Click <strong>EXPORT PACKAGE</strong>. Choose imagery (GeoPackage for
              large areas, KMZ-GRG for small ones) and zoom range, toggle elevation
              (DTED) and the mission brief, then build. You get a single{" "}
              <code>.zip</code> — copy it to the device's{" "}
              <code>atak/tools/datapackage</code> folder (or send it via Import
              Manager) and import.
            </p>
          </div>

          <div className="panel-section">
            <div className="label">5 · SAVE / LOAD YOUR WORK</div>
            <p className="help-text">
              There's no login. Use <strong>SAVE</strong> in the header to download a{" "}
              <code>.takproj.json</code> project file with your whole map and comms
              setup, and <strong>LOAD</strong> to restore it in a later session or on
              another machine. API keys are <em>not</em> stored in the project file.
            </p>
          </div>

          <div className="panel-section">
            <div className="label">TIPS</div>
            <ul className="help-list">
              <li>Imagery licensing is enforced — stream-only sources can't be packaged offline.</li>
              <li>Keep DTED AOIs small; DTED2 cells are ~26&nbsp;MB each.</li>
              <li>Double-click (or the Finish button) completes a multi-point draw.</li>
            </ul>
          </div>
        </div>

        <div className="dialog-footer">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            GOT IT
          </button>
        </div>
      </div>
    </div>
  );
}
