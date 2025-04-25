```Mermaid
flowchart TD
    A["Archive All in Vault"] --> B["Apply Path/Word Patterns"]
    B --> C["Apply URL Patterns"]
    C --> D{"Adjacent Archive?"}
    D -->|Yes| E{"Fresh?"}
    D -->|No| F{"Latest Archive Fresh?"}
    E -->|Yes| G["Skip"]
    E -->|No| H["Replace Archive"]
    F -->|Yes| I["Insert Latest Archive"]
    F -->|No| J["Insert Fresh Archive"]
    H & I & J --> K{"Success?"}
    K -->|Yes| L["Log Success"]
    K -->|No| M["Log Failure or Limited"]