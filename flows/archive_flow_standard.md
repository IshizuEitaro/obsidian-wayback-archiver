```Mermaid
flowchart TD
    A["Archive Current Note"] --> B{"Selection?"}
    B -->|Yes| C["Process Selected Links"]
    B -->|No| D["Process All Links"]
    C & D --> E["Apply URL Patterns"]
    E --> F{"Adjacent Archive?"}
    F -->|Yes| G{"Fresh?"}
    F -->|No| H{"Latest Archive Fresh?"}
    G -->|Yes| I["Skip"]
    G -->|No| J["Replace Archive"]
    H -->|Yes| K["Insert Latest Archive"]
    H -->|No| L["Insert Fresh Archive"]
    J & K & L --> M{"Success?"}
    M -->|Yes| N["Log Success"]
    M -->|No| O["Log Failure"]