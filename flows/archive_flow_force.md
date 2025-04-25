```mermaid
flowchart TD
    A["Force Re-archive"] --> B{"Selection?"}
    B -->|Yes| C["Process Selected Links"]
    B -->|No| D["Process All Links"]
    C & D --> E["Apply URL Patterns"]
    E --> F["Always Archive"]
    F --> G{"Adjacent Archive?"}
    G -->|Yes| H["Replace Archive"]
    G -->|No| I["Insert Archive Link"]
    H & I --> J{"Success?"}
    J -->|Yes| K["Log Success"]
    J -->|No| L["Log Failure or Limited"]